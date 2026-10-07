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

describe('execute_query_window step (#200)', () => {
  const startsAtMs = 1_800_000_000_000;
  const endsAtMs = startsAtMs + 3_600_000;

  function pinnedDashboard(interval?: string): DashboardGetResponse {
    return {
      dashboard: {
        uid: 'slo',
        title: 'SLO',
        version: 1,
        panels: [
          {
            id: 1,
            title: '5xx per minute',
            ...(interval !== undefined ? { interval } : {}),
            targets: [
              { refId: 'A', datasource: { uid: 'prom', type: 'prometheus' }, expr: 'sum(increase(http_status_count{http_code=~"5.*"}[1m]))' },
              { refId: 'B', datasource: { uid: 'influx1' }, query: 'SELECT count(v) FROM m WHERE $timeFilter GROUP BY time($__interval)', rawQuery: true },
            ],
          },
        ],
      },
      meta: {},
    };
  }

  /** Answers every query with a flat series sampled every `stepMs` across the requested window. */
  function answerEvery(queryDs: ReturnType<typeof vi.fn>, stepMs: number): void {
    queryDs.mockImplementation(async (req: DsQueryRequest): Promise<DsQueryResponse> => {
      const from = Number(req.from);
      const to = Number(req.to);
      const times: number[] = [];
      for (let t = from; t <= to; t += stepMs) times.push(t);
      return {
        results: Object.fromEntries(
          req.queries.map((q) => [
            q.refId,
            { frames: [{ schema: { refId: q.refId, fields: [{ name: 'time', type: 'time' }, { name: 'value', type: 'number' }] }, data: { values: [times, times.map(() => 0)] } }] },
          ]),
        ),
      };
    });
  }

  async function run(dashboard: DashboardGetResponse, args: Record<string, unknown> = {}, stepMs?: number) {
    const { client, queryDs } = fakeGrafanaClient({ dashboard });
    if (stepMs !== undefined) answerEvery(queryDs, stepMs);
    const { server, call } = fakeServer();
    registerExecuteQueryWindow(server, { registry: fakeRegistry(connections, client), config: config() });
    const result = (await call('execute_query_window', {
      dashboardUid: 'slo',
      panelId: 1,
      startsAtMs,
      endsAtMs,
      includeControls: false,
      connection: 'test',
      ...args,
    })) as { content: Array<{ text: string }> };
    return { parsed: JSON.parse(result.content[0]!.text), queryDs };
  }

  it('sends the panel\'s min interval as intervalMs, and substitutes the same step for $__interval', async () => {
    const { queryDs } = await run(pinnedDashboard('1m'));
    const [prom, influx] = (queryDs.mock.calls[0]![0] as DsQueryRequest).queries;
    expect(prom!.intervalMs).toBe(60_000);
    expect(influx!.intervalMs).toBe(60_000);
    expect(influx!.query).toContain('GROUP BY time(1m)');
  });

  it('reports the step on every window, and confirms it when the timestamps agree', async () => {
    const { parsed } = await run(pinnedDashboard('1m'), {}, 60_000);
    expect(parsed.incident.step).toMatchObject({ source: 'panel', panelInterval: '1m', requestedMs: 60_000, observedGapGcdMs: 60_000, consistentWithRequested: true });
    expect(parsed.preWindow.step).toMatchObject({ source: 'panel', requestedMs: 60_000 });
    expect(parsed.stepWarnings).toBeUndefined();
  });

  it('lifts a step Grafana did not honour to a top-level stepWarnings', async () => {
    const { parsed } = await run(pinnedDashboard('1m'), {}, 15_000);
    expect(parsed.incident.step.consistentWithRequested).toBe(false);
    expect(parsed.stepWarnings).toHaveLength(1);
    expect(parsed.stepWarnings[0]).toContain('incident (60000ms requested)');
  });

  it('sends no intervalMs for a panel with no min interval, and says Grafana\'s default chose the step', async () => {
    const { parsed, queryDs } = await run(pinnedDashboard(), {}, 15_000);
    expect((queryDs.mock.calls[0]![0] as DsQueryRequest).queries[0]!.intervalMs).toBeUndefined();
    expect(parsed.incident.step).toMatchObject({ source: 'datasource-default', observedGapGcdMs: 15_000 });
    expect(parsed.incident.step.sourceNote).toContain('no min interval');
    expect(parsed.stepWarnings).toBeUndefined();
  });

  it('warns at the top level when the panel\'s min interval could not be read', async () => {
    const { parsed, queryDs } = await run(pinnedDashboard('$nope'), {}, 15_000);
    expect((queryDs.mock.calls[0]![0] as DsQueryRequest).queries[0]!.intervalMs).toBeUndefined();
    expect(parsed.incident.step.panelIntervalIgnored).toBe('$nope');
    expect(parsed.stepWarnings.join(' ')).toContain('"$nope" couldn\'t be read');
  });

  it('lets minIntervalMs replace the panel floor for one call', async () => {
    const { parsed, queryDs } = await run(pinnedDashboard('1m'), { minIntervalMs: 15_000 }, 15_000);
    expect((queryDs.mock.calls[0]![0] as DsQueryRequest).queries[0]!.intervalMs).toBe(15_000);
    expect(parsed.incident.step).toMatchObject({ source: 'minIntervalMs', requestedMs: 15_000, panelInterval: '1m', consistentWithRequested: true });
    expect(parsed.incident.step.sourceNote).toContain('replacing the panel\'s own "1m"');
  });
});

describe('execute_query_window on a Prometheus panel with no min interval', () => {
  const startsAtMs = 1_800_000_000_000;

  function unpinnedPromDashboard(): DashboardGetResponse {
    return {
      dashboard: {
        uid: 'api',
        title: 'API',
        version: 1,
        panels: [
          {
            id: 1,
            title: 'Request rate',
            targets: [{ refId: 'A', datasource: { uid: 'prom', type: 'prometheus' }, expr: 'sum(rate(http_requests_total[$__interval]))' }],
          },
        ],
      },
      meta: {},
    };
  }

  async function run(datasource: Record<string, unknown>, spanMs = 3_600_000) {
    const { client, queryDs, listDatasources } = fakeGrafanaClient({ dashboard: unpinnedPromDashboard() });
    listDatasources.mockResolvedValue([{ uid: 'prom', id: 2, name: 'Prometheus', type: 'prometheus', ...datasource }]);
    const { server, call } = fakeServer();
    registerExecuteQueryWindow(server, { registry: fakeRegistry(connections, client), config: config() });
    const result = (await call('execute_query_window', {
      dashboardUid: 'api',
      panelId: 1,
      startsAtMs,
      endsAtMs: startsAtMs + spanMs,
      includeControls: false,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const sent = (queryDs.mock.calls[0]![0] as DsQueryRequest).queries[0]!;
    return { parsed: JSON.parse(result.content[0]!.text), sent };
  }

  // Grafana's Prometheus backend (promlib's CalculatePrometheusInterval) floors a
  // query with no intervalMs at the datasource's scrape interval, 15s when unset,
  // so the step is 15s here. Writing span/maxDataPoints (1h/2000 -> 5s) into the
  // text instead asks rate() over a 5s range at a 15s step: an empty answer.
  it('writes the step Grafana evaluates at into $__interval: the 15s default scrape interval', async () => {
    const { parsed, sent } = await run({ jsonData: {} });
    expect(sent.expr).toBe('sum(rate(http_requests_total[15s]))');
    expect(sent.intervalMs).toBe(15_000);
    expect(parsed.incident.step).toMatchObject({ source: 'datasource', requestedMs: 15_000 });
  });

  it('uses the datasource\'s configured scrape interval when it has one', async () => {
    const { parsed, sent } = await run({ jsonData: { timeInterval: '30s' } });
    expect(sent.expr).toBe('sum(rate(http_requests_total[30s]))');
    expect(sent.intervalMs).toBe(30_000);
    expect(parsed.incident.step.sourceNote).toContain('scrape interval "30s"');
  });

  it('still coarsens past the scrape interval when the window needs it', async () => {
    const { sent } = await run({ jsonData: {} }, 86_400_000);
    expect(sent.expr).toBe('sum(rate(http_requests_total[1m]))');
    expect(sent.intervalMs).toBe(60_000);
  });

  it('sends no step for a panel over two datasources, whose floors can differ', async () => {
    const dashboard = unpinnedPromDashboard();
    const panel = dashboard.dashboard.panels![0]!;
    panel.targets = [...panel.targets!, { refId: 'B', datasource: { uid: 'prom2', type: 'prometheus' }, expr: 'up' }];
    const { client, queryDs, listDatasources } = fakeGrafanaClient({ dashboard });
    listDatasources.mockResolvedValue([
      { uid: 'prom', id: 2, name: 'Prometheus', type: 'prometheus', jsonData: {} },
      { uid: 'prom2', id: 3, name: 'Prometheus 2', type: 'prometheus', jsonData: { timeInterval: '1m' } },
    ]);
    const { server, call } = fakeServer();
    registerExecuteQueryWindow(server, { registry: fakeRegistry(connections, client), config: config() });
    await call('execute_query_window', { dashboardUid: 'api', panelId: 1, startsAtMs, endsAtMs: startsAtMs + 3_600_000, includeControls: false, connection: 'test' });
    expect((queryDs.mock.calls[0]![0] as DsQueryRequest).queries.map((q) => q.intervalMs)).toEqual([undefined, undefined]);
  });

  it('sends no step when the datasource\'s settings could not be read, rather than guess its floor', async () => {
    const { parsed, sent } = await run({});
    expect(sent.intervalMs).toBeUndefined();
    expect(parsed.incident.step.source).toBe('datasource-default');
  });
});
