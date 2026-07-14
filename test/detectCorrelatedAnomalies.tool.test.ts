import { describe, expect, it } from 'vitest';
import { registerDetectCorrelatedAnomalies } from '../src/tools/detectCorrelatedAnomalies.js';
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

function dashboardWithAllVariable(panelId: number): DashboardGetResponse {
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
          id: panelId,
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

function dashboardWithMirrorCandidate(): DashboardGetResponse {
  return {
    dashboard: {
      uid: 'dash1',
      title: 'Dash',
      version: 1,
      panels: [
        { id: 1, title: 'Primary', targets: [{ refId: 'A', datasource: { uid: 'influx1' }, expr: 'up' }] },
        { id: 2, title: 'Mirror', datasource: { uid: '-- Dashboard --' }, targets: [{ refId: 'A', panelId: 1 }] },
      ],
    },
    meta: {},
  };
}

describe('detect_correlated_anomalies tool', () => {
  it('skips a candidate that mirrors another panel via "-- Dashboard --" instead of failing the whole call', async () => {
    const { client } = fakeGrafanaClient({ dashboard: dashboardWithMirrorCandidate() });
    const { server, call } = fakeServer();
    registerDetectCorrelatedAnomalies(server, { registry: fakeRegistry(connections, client), config: config() });

    const startsAtMs = Date.parse('2026-07-07T15:38:50Z');
    const endsAtMs = Date.parse('2026-07-07T16:38:50Z');
    const result = (await call('detect_correlated_anomalies', {
      primaryDashboardUid: 'dash1',
      primaryPanelId: 1,
      startsAtMs,
      endsAtMs,
      candidates: [{ dashboardUid: 'dash1', panelId: 2, connectionId: 'test' }],
      // fakeServer's call() bypasses zod (unlike the real MCP server), so the
      // schema's limit default isn't applied here - pass it explicitly.
      limit: 10,
      connection: 'test',
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.candidatesChecked).toBe(1);
    expect(parsed.correlated).toEqual([]);
  });


  it('live-resolves the primary panel\'s "$__all" variable exactly once, and never for candidate panels', async () => {
    const { client, queryDs } = fakeGrafanaClient({ dashboard: dashboardWithAllVariable(1), liveValues: ['h1', 'h2'] });
    const { server, call } = fakeServer();
    registerDetectCorrelatedAnomalies(server, { registry: fakeRegistry(connections, client), config: config() });

    const startsAtMs = Date.parse('2026-07-07T15:38:50Z');
    const endsAtMs = Date.parse('2026-07-07T16:38:50Z');
    const result = (await call('detect_correlated_anomalies', {
      primaryDashboardUid: 'dash1',
      primaryPanelId: 1,
      startsAtMs,
      endsAtMs,
      candidates: [{ dashboardUid: 'dash2', panelId: 2, connectionId: 'test' }],
      connection: 'test',
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    const variableCalls = queryDs.mock.calls.filter(([req]: [DsQueryRequest]) => req.queries[0]!.refId === 'variable');
    expect(variableCalls).toHaveLength(1);
    expect(parsed.unresolvedAllVariables).toBeUndefined();
  });
});
