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

describe('detect_correlated_anomalies tool', () => {
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
