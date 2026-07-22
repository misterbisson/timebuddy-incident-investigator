import { describe, expect, it, vi } from 'vitest';
import { registerExecuteQueryWindow } from '../src/tools/executeQueryWindow.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { DashboardGetResponse, DsQueryRequest, DsQueryResponse } from '../src/grafana/types.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import { fakeGrafanaClient, fakeRegistry, fakeServer } from './toolTestHelpers.js';

const connections: GrafanaConnection[] = [{ id: 'test', name: 'test', url: 'https://grafana.example.com', authType: 'bearer', token: 'x' }];

function config(): Config {
  return {
    connections,
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
}

function dashboardWithAllVariable(): DashboardGetResponse {
  return {
    dashboard: {
      uid: 'dash1',
      title: 'Host connectivity',
      version: 1,
      templating: {
        list: [
          {
            name: 'unreachable_target_hosts',
            type: 'query',
            datasource: { uid: 'influx1', type: 'influxdb' },
            query: 'SHOW TAG VALUES FROM "m" WITH KEY = "target_host" WHERE $timeFilter',
            current: { value: '$__all' },
          },
        ],
      },
      panels: [
        {
          id: 1,
          title: 'Unreachable target hosts',
          targets: [
            { refId: 'A', datasource: { uid: 'influx1' }, query: 'SELECT mean("v") FROM "m" WHERE "target_host" =~ /$unreachable_target_hosts/', rawQuery: true },
          ],
        },
      ],
    },
    meta: {},
  };
}

function dashboardWithBuilderPanel(): DashboardGetResponse {
  return {
    dashboard: {
      uid: 'dash1',
      title: 'CPU load',
      version: 1,
      panels: [
        {
          id: 1,
          title: 'CPU load (all hosts)',
          targets: [
            {
              refId: 'A',
              datasource: { uid: 'influx1' },
              measurement: 'cpu_load',
              rawQuery: false,
              select: [[{ type: 'field', params: ['value'] }, { type: 'mean', params: [] }]],
              groupBy: [{ type: 'time', params: ['$__interval'] }, { type: 'fill', params: ['null'] }],
            },
          ],
        },
      ],
    },
    meta: {},
  };
}

/** The transformed target Grafana would receive for the incident window (first non-variable queryDs call). */
function firstQueryTarget(queryDs: ReturnType<typeof vi.fn>): DsQueryRequest['queries'][number] {
  const call = queryDs.mock.calls.find(([req]: [DsQueryRequest]) => req.queries[0]!.refId !== 'variable');
  return call![0].queries[0];
}

describe('execute_query_window tagBreakout', () => {
  it('adds a GROUP BY tag part (before fill) to a builder-mode target when only key is given', async () => {
    const { client, queryDs } = fakeGrafanaClient({ dashboard: dashboardWithBuilderPanel() });
    const { server, call } = fakeServer();
    registerExecuteQueryWindow(server, { registry: fakeRegistry(connections, client), config: config() });

    await call('execute_query_window', {
      dashboardUid: 'dash1',
      panelId: 1,
      startsAtMs: Date.parse('2026-07-07T15:38:50Z'),
      endsAtMs: Date.parse('2026-07-07T16:38:50Z'),
      includeControls: false,
      tagBreakout: { key: 'host' },
      connection: 'test',
    });

    expect(firstQueryTarget(queryDs).groupBy).toEqual([
      { type: 'time', params: ['$__interval'] },
      { type: 'tag', params: ['host'] },
      { type: 'fill', params: ['null'] },
    ]);
  });

  it('adds a "key = value" tag filter to a builder-mode target when key and value are given', async () => {
    const { client, queryDs } = fakeGrafanaClient({ dashboard: dashboardWithBuilderPanel() });
    const { server, call } = fakeServer();
    registerExecuteQueryWindow(server, { registry: fakeRegistry(connections, client), config: config() });

    await call('execute_query_window', {
      dashboardUid: 'dash1',
      panelId: 1,
      startsAtMs: Date.parse('2026-07-07T15:38:50Z'),
      endsAtMs: Date.parse('2026-07-07T16:38:50Z'),
      includeControls: false,
      tagBreakout: { key: 'host', value: 'web-07' },
      connection: 'test',
    });

    const sent = firstQueryTarget(queryDs);
    expect(sent.tags).toEqual([{ key: 'host', operator: '=', value: 'web-07' }]);
    // Filtering must not also add a GROUP BY — it's one or the other.
    expect(sent.groupBy).toEqual([{ type: 'time', params: ['$__interval'] }, { type: 'fill', params: ['null'] }]);
  });

  it('hard-errors (does not silently run the aggregated query) when the target is raw-mode InfluxQL', async () => {
    const { client, queryDs } = fakeGrafanaClient({ dashboard: dashboardWithAllVariable(), liveValues: ['h1'] });
    const { server, call } = fakeServer();
    registerExecuteQueryWindow(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('execute_query_window', {
      dashboardUid: 'dash1',
      panelId: 1,
      startsAtMs: Date.parse('2026-07-07T15:38:50Z'),
      endsAtMs: Date.parse('2026-07-07T16:38:50Z'),
      tagBreakout: { key: 'target_host' },
      connection: 'test',
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('rawQuery: true');
    // No panel query should have been executed against Grafana (only the live
    // variable resolution, refId "variable", may have run).
    expect(queryDs.mock.calls.every(([req]: [DsQueryRequest]) => req.queries[0]!.refId === 'variable')).toBe(true);
  });
});

describe('execute_query_window tool', () => {
  it('live-resolves the "$__all" variable once for the whole call, not once per window', async () => {
    const { client, queryDs } = fakeGrafanaClient({ dashboard: dashboardWithAllVariable(), liveValues: ['h1', 'h2'] });
    const { server, call } = fakeServer();
    registerExecuteQueryWindow(server, { registry: fakeRegistry(connections, client), config: config() });

    const startsAtMs = Date.parse('2026-07-07T15:38:50Z');
    const endsAtMs = Date.parse('2026-07-07T16:38:50Z');
    const result = (await call('execute_query_window', {
      dashboardUid: 'dash1',
      panelId: 1,
      startsAtMs,
      endsAtMs,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    // incident + preWindow + 3 default controls = 5 windows, but the live
    // variable-resolution query ("variable" refId) must fire exactly once —
    // otherwise a baseline control window could resolve a different host
    // list than the incident window, breaking the comparison.
    const variableCalls = queryDs.mock.calls.filter(([req]: [DsQueryRequest]) => req.queries[0]!.refId === 'variable');
    expect(variableCalls).toHaveLength(1);
    expect(parsed.unresolvedAllVariables).toBeUndefined();
    expect(parsed.incident.series[0]).toBeDefined();
  });

  it('lists the variable in unresolvedAllVariables when live resolution fails, without failing the call', async () => {
    const { client } = fakeGrafanaClient({ dashboard: dashboardWithAllVariable(), liveValues: [] });
    const { server, call } = fakeServer();
    registerExecuteQueryWindow(server, { registry: fakeRegistry(connections, client), config: config() });

    const startsAtMs = Date.parse('2026-07-07T15:38:50Z');
    const endsAtMs = Date.parse('2026-07-07T16:38:50Z');
    const result = (await call('execute_query_window', {
      dashboardUid: 'dash1',
      panelId: 1,
      startsAtMs,
      endsAtMs,
      connection: 'test',
    })) as { content: Array<{ text: string }>; isError?: boolean };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(result.isError).toBeUndefined();
    expect(parsed.unresolvedAllVariables).toEqual(['unreachable_target_hosts']);
  });

  it('omits raw points but keeps stats/pointsTotal when includePoints is false', async () => {
    const { client } = fakeGrafanaClient({ dashboard: dashboardWithAllVariable(), liveValues: ['h1'] });
    const { server, call } = fakeServer();
    registerExecuteQueryWindow(server, { registry: fakeRegistry(connections, client), config: config() });

    const startsAtMs = Date.parse('2026-07-07T15:38:50Z');
    const endsAtMs = Date.parse('2026-07-07T16:38:50Z');
    const result = (await call('execute_query_window', {
      dashboardUid: 'dash1',
      panelId: 1,
      startsAtMs,
      endsAtMs,
      includePoints: false,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    const series = parsed.incident.series[0];
    expect(series.points).toBeUndefined();
    expect(series.stats).toBeDefined();
    expect(series.pointsTotal).toBeGreaterThan(0);
  });

  it('returns a clear error instead of a 404 when the panel mirrors another via "-- Dashboard --"', async () => {
    const dashboard: DashboardGetResponse = {
      dashboard: {
        uid: 'dash1',
        title: 'Host connectivity',
        version: 1,
        panels: [
          { id: 4, title: 'Success rate over time', datasource: { uid: 'influx1' }, targets: [{ refId: 'A', query: 'SELECT mean("success")' }] },
          { id: 6, title: 'Success rate (stat)', datasource: { uid: '-- Dashboard --' }, targets: [{ refId: 'A', panelId: 4 }] },
        ],
      },
      meta: {},
    };
    const { client } = fakeGrafanaClient({ dashboard });
    const { server, call } = fakeServer();
    registerExecuteQueryWindow(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('execute_query_window', {
      dashboardUid: 'dash1',
      panelId: 6,
      startsAtMs: Date.parse('2026-07-07T15:38:50Z'),
      endsAtMs: Date.parse('2026-07-07T16:38:50Z'),
      connection: 'test',
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('-- Dashboard --');
    expect(result.content[0]!.text).toContain('panel 4');
  });

  it('includes raw points by default', async () => {
    const { client } = fakeGrafanaClient({ dashboard: dashboardWithAllVariable(), liveValues: ['h1'] });
    const { server, call } = fakeServer();
    registerExecuteQueryWindow(server, { registry: fakeRegistry(connections, client), config: config() });

    const startsAtMs = Date.parse('2026-07-07T15:38:50Z');
    const endsAtMs = Date.parse('2026-07-07T16:38:50Z');
    const result = (await call('execute_query_window', {
      dashboardUid: 'dash1',
      panelId: 1,
      startsAtMs,
      endsAtMs,
      includePoints: true,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(Array.isArray(parsed.incident.series[0].points)).toBe(true);
  });

  // Regression for the case where the response clamp also truncated the input
  // to computeStats/findThresholdRuns: a short dip landing between surviving
  // samples was reported as "never left full health" during a real outage.
  it('computes stats and runs from the full series, not the downsampled points', async () => {
    // A raw InfluxQL target with no `GROUP BY time()` ignores maxDataPoints and
    // returns every 1s sample over the window — ~21.6k points against a 2000 cap.
    const pointCount = 21_600;
    const times = Array.from({ length: pointCount }, (_, i) => 1_700_000_000_000 + i * 1000);
    const values = Array.from({ length: pointCount }, () => 1);
    // Stride is 21600/2000 = 10.8, so kept indexes run 0, 10, 21, 32, ... —
    // indexes 1-3 survive nowhere in the emitted points.
    values[1] = 0;
    values[2] = 0;
    values[3] = 0;

    const dashboard: DashboardGetResponse = {
      dashboard: {
        uid: 'dash1',
        title: 'Uptime',
        version: 1,
        panels: [
          {
            id: 1,
            title: 'Target uptime',
            targets: [{ refId: 'A', datasource: { uid: 'influx1' }, query: 'SELECT "v" FROM "m"', rawQuery: true }],
          },
        ],
      },
      meta: {},
    };
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
    const client = {
      getDashboard: vi.fn(async () => dashboard),
      queryDs: vi.fn(async (_req: DsQueryRequest) => response),
      listDatasources: vi.fn(async () => [{ uid: 'influx1', id: 1, name: 'InfluxDB', type: 'influxdb' }]),
    } as unknown as GrafanaClient;

    const { server, call } = fakeServer();
    registerExecuteQueryWindow(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('execute_query_window', {
      dashboardUid: 'dash1',
      panelId: 1,
      startsAtMs: Date.parse('2026-07-07T15:38:50Z'),
      endsAtMs: Date.parse('2026-07-07T16:38:50Z'),
      threshold: 1,
      thresholdDirection: 'below',
      includePoints: true,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const series = JSON.parse(result.content[0]!.text).incident.series[0];

    // The outage is found even though none of its samples are in `points`.
    expect(series.runs).toHaveLength(1);
    expect(series.runs[0].pointCount).toBe(3);
    expect(series.stats.min).toBe(0);

    // ...and the response is still bounded.
    expect(series.points).toHaveLength(2000);
    expect(series.pointsTotal).toBe(pointCount);
    expect(series.points.some((p: { v: number }) => p.v === 0)).toBe(false);
  });
});
