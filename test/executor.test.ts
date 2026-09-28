import { describe, expect, it } from 'vitest';
import { executeQueryWindow } from '../src/query/executor.js';
import { LimitExceededError } from '../src/security/limits.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { Config } from '../src/config.js';
import type { DsQueryResponse } from '../src/grafana/types.js';

const config: Config = {
  connections: [{ id: 'test', name: 'test', url: 'https://grafana.example.com', authType: 'bearer', token: 'x' }],
  tlsVerify: true,
  requestTimeoutMs: 1000,
  screenshotTimeoutMs: 45000,
  maxConcurrency: 4,
  maxLookbackHours: 720,
  maxDataPoints: 2000,
  redactionPatterns: [],
  dataDir: '.data',
  webhookPort: 4318,
};

function fakeClient(response: DsQueryResponse): GrafanaClient {
  return { queryDs: async () => response } as unknown as GrafanaClient;
}

describe('executeQueryWindow', () => {
  const window = { label: 'incident', fromMs: 1_700_000_000_000, toMs: 1_700_000_600_000 };

  it('parses time+value frames into series with labels', async () => {
    const response: DsQueryResponse = {
      results: {
        A: {
          frames: [
            {
              schema: {
                refId: 'A',
                fields: [
                  { name: 'Time', type: 'time' },
                  { name: 'Value', type: 'number', labels: { service: 'checkout' } },
                ],
              },
              data: { values: [[1_700_000_000_000, 1_700_000_060_000], [1, 2]] },
            },
          ],
        },
      },
    };
    const client = fakeClient(response);
    const result = await executeQueryWindow(client, [{ refId: 'A', datasourceUid: 'prom1', raw: { refId: 'A', expr: 'up' } }], window, config);
    expect(result.series).toHaveLength(1);
    expect(result.series[0]?.labels).toEqual({ service: 'checkout' });
    expect(result.series[0]?.points).toEqual([
      { t: 1_700_000_000_000, v: 1 },
      { t: 1_700_000_060_000, v: 2 },
    ]);
  });

  it('surfaces per-refId errors without throwing', async () => {
    const response: DsQueryResponse = { results: { A: { error: 'datasource unreachable' } } };
    const result = await executeQueryWindow(
      fakeClient(response),
      [{ refId: 'A', datasourceUid: 'prom1', raw: { refId: 'A', expr: 'up' } }],
      window,
      config,
    );
    expect(result.errors.A).toBe('datasource unreachable');
    expect(result.series).toEqual([]);
  });

  it('returns the full series a datasource sent despite maxDataPoints, leaving downsampling to the emitting tool', async () => {
    const pointCount = config.maxDataPoints * 10;
    const times = Array.from({ length: pointCount }, (_, i) => 1_700_000_000_000 + i * 1000);
    const values = Array.from({ length: pointCount }, (_, i) => i);
    const response: DsQueryResponse = {
      results: {
        A: {
          frames: [
            {
              schema: { refId: 'A', fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number' }] },
              data: { values: [times, values] },
            },
          ],
        },
      },
    };
    const result = await executeQueryWindow(
      fakeClient(response),
      [{ refId: 'A', datasourceUid: 'prom1', raw: { refId: 'A', expr: 'up' } }],
      window,
      config,
    );
    // The clamp is a response-shaping step applied where points are emitted
    // (execute_query_window / render_dashboard), not at this boundary — every
    // analysis downstream reads these points and needs them un-subsampled.
    expect(result.series[0]?.points).toHaveLength(pointCount);
  });

  it('rejects a target with no resolvable datasource uid', async () => {
    await expect(
      executeQueryWindow(fakeClient({ results: {} }), [{ refId: 'A', raw: { refId: 'A', expr: 'up' } }], window, config),
    ).rejects.toThrow(/no resolvable datasource/);
  });

  it('enforces the max lookback window limit', async () => {
    const hugeWindow = { label: 'incident', fromMs: 0, toMs: 800 * 3_600_000 };
    await expect(
      executeQueryWindow(
        fakeClient({ results: {} }),
        [{ refId: 'A', datasourceUid: 'prom1', raw: { refId: 'A', expr: 'up' } }],
        hugeWindow,
        config,
      ),
    ).rejects.toThrow(LimitExceededError);
  });

  // #263: a log query's frame is a time field plus string fields and no number
  // field. Dropping it silently made "this query returned log lines" read as
  // "this panel had no data in the window".
  describe('log-lines frames', () => {
    const logFrame = (rows: number) => ({
      schema: {
        refId: 'A',
        meta: { type: 'log-lines' },
        fields: [
          { name: 'labels', type: 'other' },
          { name: 'Time', type: 'time' },
          { name: 'Line', type: 'string' },
          { name: 'tsNs', type: 'string' },
          { name: 'id', type: 'string' },
        ],
      },
      data: {
        values: [
          Array.from({ length: rows }, () => ({ app: 'checkout' })),
          Array.from({ length: rows }, (_, i) => 1_700_000_000_000 + i),
          Array.from({ length: rows }, () => 'GET /cart 500'),
          Array.from({ length: rows }, (_, i) => String((1_700_000_000_000 + i) * 1e6)),
          Array.from({ length: rows }, (_, i) => String(i)),
        ],
      },
    });
    const target = { refId: 'A', datasourceUid: 'logs1', raw: { refId: 'A', expr: '{app="checkout"}' } };

    it('reports a log-lines frame as an error for its refId instead of returning nothing', async () => {
      const client = fakeClient({ results: { A: { frames: [logFrame(3)] } } } as DsQueryResponse);
      const result = await executeQueryWindow(client, [target], window, config);
      expect(result.series).toEqual([]);
      expect(result.errors.A).toMatch(/3 row\(s\) of text/);
      expect(result.errors.A).toMatch(/count_over_time/);
    });

    it('still reports it when the log query matched nothing', async () => {
      const client = fakeClient({ results: { A: { frames: [logFrame(0)] } } } as DsQueryResponse);
      const result = await executeQueryWindow(client, [target], window, config);
      expect(result.errors.A).toMatch(/0 row\(s\) of text/);
    });

    it('leaves a frame with a string label column and a numeric value alone', async () => {
      const response: DsQueryResponse = {
        results: {
          A: {
            frames: [
              {
                schema: {
                  refId: 'A',
                  fields: [
                    { name: 'Time', type: 'time' },
                    { name: 'host', type: 'string' },
                    { name: 'Value', type: 'number' },
                  ],
                },
                data: { values: [[1_700_000_000_000], ['h1'], [4]] },
              },
            ],
          },
        },
      };
      const result = await executeQueryWindow(fakeClient(response), [target], window, config);
      expect(result.series).toHaveLength(1);
      expect(result.errors).toEqual({});
    });

    // Review of #267: the check ran per frame but errors are keyed per refId,
    // so a refId returning a numeric frame *and* a text frame — InfluxQL's
    // SELECT mean("value"), last("state") comes back as one frame per column —
    // got a valid series plus an error saying there was nothing to compute.
    it('does not report a refId that also returned numeric series, and keeps its series', async () => {
      const response: DsQueryResponse = {
        results: {
          A: {
            frames: [
              {
                schema: { refId: 'A', fields: [{ name: 'Time', type: 'time' }, { name: 'value', type: 'number' }] },
                data: { values: [[1_700_000_000_000, 1_700_000_060_000], [1, 2]] },
              },
              {
                schema: { refId: 'A', fields: [{ name: 'Time', type: 'time' }, { name: 'state', type: 'string' }] },
                data: { values: [[1_700_000_000_000, 1_700_000_060_000], ['ok', 'degraded']] },
              },
            ],
          },
        },
      };
      const result = await executeQueryWindow(fakeClient(response), [target], window, config);
      expect(result.series).toHaveLength(1);
      expect(result.series[0]!.points.map((p) => p.v)).toEqual([1, 2]);
      expect(result.errors).toEqual({});
    });

    it('reports the text-only refId when another refId in the same request is numeric', async () => {
      const response: DsQueryResponse = {
        results: {
          A: {
            frames: [
              {
                schema: { refId: 'A', fields: [{ name: 'Time', type: 'time' }, { name: 'value', type: 'number' }] },
                data: { values: [[1_700_000_000_000], [1]] },
              },
            ],
          },
          B: { frames: [{ ...logFrame(2), schema: { ...logFrame(2).schema, refId: 'B' } }] },
        },
      };
      const result = await executeQueryWindow(fakeClient(response), [target, { ...target, refId: 'B' }], window, config);
      expect(result.series.map((s) => s.refId)).toEqual(['A']);
      expect(Object.keys(result.errors)).toEqual(['B']);
      expect(result.errors.B).toMatch(/2 row\(s\) of text/);
    });

    it('does not overwrite a datasource error already reported for the same refId', async () => {
      const client = fakeClient({ results: { A: { error: 'parse error at line 1', frames: [logFrame(1)] } } } as DsQueryResponse);
      const result = await executeQueryWindow(client, [target], window, config);
      expect(result.errors.A).toBe('parse error at line 1');
    });
  });
});
