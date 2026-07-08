import { describe, expect, it } from 'vitest';
import { registerExecuteQueryWindow } from '../src/tools/executeQueryWindow.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { DashboardGetResponse, DsQueryRequest } from '../src/grafana/types.js';
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
});
