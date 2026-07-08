import { describe, expect, it } from 'vitest';
import { registerRenderDashboard } from '../src/tools/renderDashboard.js';
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
      time: { from: 'now-1h', to: 'now' },
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

describe('render_dashboard tool', () => {
  it('live-resolves a "$__all" variable for the actual query, but keeps dashboard/panel URLs built from the original (un-expanded) override', async () => {
    const { client } = fakeGrafanaClient({ dashboard: dashboardWithAllVariable(), liveValues: ['h1', 'h2', 'h3'] });
    const { server, call } = fakeServer();
    registerRenderDashboard(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('render_dashboard', {
      dashboardUid: 'dash1',
      fromMs: 1_700_000_000_000,
      toMs: 1_700_003_600_000,
      variableOverrides: { unreachable_target_hosts: ['$__all'] },
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.unresolvedAllVariables).toBeUndefined();
    const panel = parsed.panels.find((p: { panelId: number }) => p.panelId === 1);
    expect(panel.targets[0].resolvedQuery.query).toContain('(h1|h2|h3)');
    // The clickable URL must reflect what a human actually selected ($__all), not the
    // internally-expanded three-host list — an exploded var-* query param would be an
    // unusable (and potentially enormous) link.
    expect(panel.url).toBe(
      'https://grafana.example.com/d/dash1?viewPanel=1&from=1700000000000&to=1700003600000&var-unreachable_target_hosts=%24__all',
    );
  });

  it('lists the variable in unresolvedAllVariables when live resolution finds nothing', async () => {
    const { client } = fakeGrafanaClient({ dashboard: dashboardWithAllVariable(), liveValues: [] });
    const { server, call } = fakeServer();
    registerRenderDashboard(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('render_dashboard', {
      dashboardUid: 'dash1',
      fromMs: 1_700_000_000_000,
      toMs: 1_700_003_600_000,
      variableOverrides: { unreachable_target_hosts: ['$__all'] },
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.unresolvedAllVariables).toEqual(['unreachable_target_hosts']);
  });

  it('does not silently drop a panel when two panels share the same panelId', async () => {
    const dashboard: DashboardGetResponse = {
      dashboard: {
        uid: 'dash2',
        title: 'Duplicate ids',
        version: 1,
        time: { from: 'now-1h', to: 'now' },
        panels: [
          { id: 9, title: 'Compute', targets: [{ refId: 'A', datasource: { uid: 'prom1' }, expr: 'up{product="compute"}' }] },
          { id: 9, title: 'Block Storage', targets: [{ refId: 'A', datasource: { uid: 'prom1' }, expr: 'up{product="block-storage"}' }] },
          { id: 10, title: 'Row header (non-queryable)', type: 'row' },
        ],
      },
      meta: {},
    };
    const { client } = fakeGrafanaClient({ dashboard });
    const { server, call } = fakeServer();
    registerRenderDashboard(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('render_dashboard', {
      dashboardUid: 'dash2',
      fromMs: 1_700_000_000_000,
      toMs: 1_700_003_600_000,
      // fakeServer's call() bypasses zod (unlike the real MCP server), so the
      // schema's panelLimit default isn't applied here - pass it explicitly.
      panelLimit: 25,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.panelsTotal).toBe(2);
    const titles = parsed.panels.map((p: { title?: string }) => p.title);
    expect(titles).toContain('Compute');
    expect(titles).toContain('Block Storage');
    expect(titles).toContain('Row header (non-queryable)');
    expect(parsed.panels).toHaveLength(3);
  });

  it('marks a duplicate-panelId panel beyond panelLimit as skipped rather than dropping it', async () => {
    const dashboard: DashboardGetResponse = {
      dashboard: {
        uid: 'dash2',
        title: 'Duplicate ids',
        version: 1,
        time: { from: 'now-1h', to: 'now' },
        panels: [
          { id: 9, title: 'Compute', targets: [{ refId: 'A', datasource: { uid: 'prom1' }, expr: 'up{product="compute"}' }] },
          { id: 9, title: 'Block Storage', targets: [{ refId: 'A', datasource: { uid: 'prom1' }, expr: 'up{product="block-storage"}' }] },
        ],
      },
      meta: {},
    };
    const { client } = fakeGrafanaClient({ dashboard });
    const { server, call } = fakeServer();
    registerRenderDashboard(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('render_dashboard', {
      dashboardUid: 'dash2',
      fromMs: 1_700_000_000_000,
      toMs: 1_700_003_600_000,
      panelLimit: 1,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.panelsExecuted).toBe(1);
    expect(parsed.panelsSkipped).toBe(1);
    const skipped = parsed.panels.find((p: { skipped?: boolean }) => p.skipped);
    expect(skipped.title).toBe('Block Storage');
  });

  it('reports a mirror panel ("-- Dashboard --" datasource) with mirrorsPanelIds instead of a 404', async () => {
    const dashboard: DashboardGetResponse = {
      dashboard: {
        uid: 'dash3',
        title: 'Glue',
        version: 1,
        time: { from: 'now-1h', to: 'now' },
        panels: [
          { id: 4, title: 'Success rate over time', datasource: { uid: 'influx1' }, targets: [{ refId: 'A', query: 'SELECT mean("success")' }] },
          { id: 6, title: 'Success rate (stat)', datasource: { uid: '-- Dashboard --' }, targets: [{ refId: 'A', panelId: 4 }] },
        ],
      },
      meta: {},
    };
    const { client } = fakeGrafanaClient({ dashboard });
    const { server, call } = fakeServer();
    registerRenderDashboard(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('render_dashboard', {
      dashboardUid: 'dash3',
      fromMs: 1_700_000_000_000,
      toMs: 1_700_003_600_000,
      panelLimit: 25,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    const mirror = parsed.panels.find((p: { panelId: number }) => p.panelId === 6);
    expect(mirror.mirrorsPanelIds).toEqual([4]);
    expect(mirror.executionError).toBeUndefined();
    expect(mirror.errors).toBeUndefined();
    // Doesn't occupy an execution slot or count toward panelsSkipped.
    expect(parsed.panelsExecuted).toBe(1);
    expect(parsed.panelsSkipped).toBe(0);
  });

  it('omits raw points but keeps stats when includePoints is false', async () => {
    const { client } = fakeGrafanaClient({ dashboard: dashboardWithAllVariable(), liveValues: ['h1', 'h2'] });
    const { server, call } = fakeServer();
    registerRenderDashboard(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('render_dashboard', {
      dashboardUid: 'dash1',
      fromMs: 1_700_000_000_000,
      toMs: 1_700_003_600_000,
      panelLimit: 25,
      includePoints: false,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    const panel = parsed.panels.find((p: { panelId: number }) => p.panelId === 1);
    expect(panel.series[0].points).toBeUndefined();
    expect(panel.series[0].stats).toBeDefined();
  });
});
