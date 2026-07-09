import { describe, expect, it } from 'vitest';
import { registerResolvePanelQueries } from '../src/tools/resolvePanelQueries.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { DashboardGetResponse } from '../src/grafana/types.js';
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
          type: 'table',
          targets: [
            {
              refId: 'A',
              datasource: { uid: 'influx1' },
              query: 'SELECT mean("v") FROM "m" WHERE "target_host" =~ /$unreachable_target_hosts/',
              rawQuery: true,
            },
          ],
        },
      ],
    },
    meta: {},
  };
}

describe('resolve_panel_queries tool', () => {
  it('returns { panels, unresolvedAllVariables } with the key omitted when everything resolved', async () => {
    const { client } = fakeGrafanaClient({ dashboard: dashboardWithAllVariable(), liveValues: ['h1', 'h2'] });
    const { server, call } = fakeServer();
    registerResolvePanelQueries(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('resolve_panel_queries', { dashboardUid: 'dash1', connection: 'test' })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(Array.isArray(parsed.panels)).toBe(true);
    expect(parsed.panels).toHaveLength(1);
    expect(parsed.unresolvedAllVariables).toBeUndefined();
    expect(parsed.panels[0].targets[0].resolvedQuery.query).toContain('(h1|h2)');
  });

  it('lists the variable in unresolvedAllVariables when live resolution finds nothing, and still returns a usable result', async () => {
    const { client } = fakeGrafanaClient({ dashboard: dashboardWithAllVariable(), liveValues: [] });
    const { server, call } = fakeServer();
    registerResolvePanelQueries(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('resolve_panel_queries', { dashboardUid: 'dash1', connection: 'test' })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.unresolvedAllVariables).toEqual(['unreachable_target_hosts']);
    expect(parsed.panels[0].targets[0].resolvedQuery.query).toContain('.*');
  });
});
