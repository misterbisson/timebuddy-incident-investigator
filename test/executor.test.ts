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
});
