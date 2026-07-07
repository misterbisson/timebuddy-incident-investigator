import { describe, expect, it } from 'vitest';
import { buildMetricIndex } from '../src/index-builder/metricIndex.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { DashboardGetResponse, RulerRuleGroup } from '../src/grafana/types.js';

function fakeClient(
  dashboards: DashboardGetResponse[],
  ruleGroupsByFolder: Record<string, RulerRuleGroup[]> = {},
): GrafanaClient {
  const byUid = new Map(dashboards.map((d) => [d.dashboard.uid, d]));
  return {
    searchDashboards: async () => dashboards.map((d) => ({ uid: d.dashboard.uid, title: d.dashboard.title, type: 'dash-db', tags: [], url: '' })),
    listDatasources: async () => [{ uid: 'prom1', id: 1, name: 'Prometheus', type: 'prometheus' }],
    getRuleGroups: async () => ruleGroupsByFolder,
    getDashboard: async (uid: string) => {
      const found = byUid.get(uid);
      if (!found) throw new Error('not found');
      return found;
    },
  } as unknown as GrafanaClient;
}

describe('buildMetricIndex', () => {
  it('indexes metrics by name and records which dashboards/panels use them', async () => {
    const dashboards: DashboardGetResponse[] = [
      {
        dashboard: {
          uid: 'd1',
          title: 'Checkout overview',
          panels: [
            {
              id: 1,
              title: 'Error rate',
              targets: [{ refId: 'A', datasource: { uid: 'prom1' }, expr: 'rate(http_requests_total{service="checkout"}[5m])' }],
            },
          ],
        },
        meta: {},
      },
      {
        dashboard: {
          uid: 'd2',
          title: 'Payments overview',
          panels: [
            {
              id: 5,
              title: 'Requests',
              targets: [{ refId: 'A', datasource: { uid: 'prom1' }, expr: 'http_requests_total{service="payments"}' }],
            },
          ],
        },
        meta: {},
      },
    ];

    const index = await buildMetricIndex(fakeClient(dashboards));
    expect(index.dashboardsScanned).toBe(2);
    const entries = index.entriesByMetric['http_requests_total'];
    expect(entries).toHaveLength(2);
    expect(entries?.map((e) => e.dashboardUid).sort()).toEqual(['d1', 'd2']);
    expect(entries?.find((e) => e.dashboardUid === 'd1')?.labels.service).toEqual(['checkout']);
  });

  it('flags panels pointing at a datasource uid that no longer exists', async () => {
    const dashboards: DashboardGetResponse[] = [
      {
        dashboard: {
          uid: 'd1',
          title: 'Stale dashboard',
          panels: [{ id: 1, title: 'Old panel', targets: [{ refId: 'A', datasource: { uid: 'missing-ds' }, expr: 'up' }] }],
        },
        meta: {},
      },
    ];
    const index = await buildMetricIndex(fakeClient(dashboards));
    expect(index.brokenDatasources).toEqual([
      { dashboardUid: 'd1', dashboardTitle: 'Stale dashboard', panelId: 1, datasourceUid: 'missing-ds' },
    ]);
  });

  it('does not flag a template variable or a Grafana pseudo-datasource as broken, but still flags a plain stale name', async () => {
    const dashboards: DashboardGetResponse[] = [
      {
        dashboard: {
          uid: 'd1',
          title: 'Templated dashboard',
          panels: [
            { id: 1, title: 'Templated', targets: [{ refId: 'A', datasource: '${datasource}', expr: 'up' }] },
            { id: 2, title: 'Templated var', targets: [{ refId: 'A', datasource: '$sysops_griffin_datasource', expr: 'up' }] },
            { id: 3, title: 'Stale name', targets: [{ refId: 'A', datasource: 'Old Datasource Name', expr: 'up' }] },
            { id: 4, title: 'Expression', targets: [{ refId: 'A', datasource: '__expr__', expr: '$A + $B' }] },
            { id: 5, title: 'Reused annotation', targets: [{ refId: 'A', datasource: '-- Dashboard --', expr: 'up' }] },
            { id: 6, title: 'Test data', targets: [{ refId: 'A', datasource: '-- Grafana --', expr: 'up' }] },
          ],
        },
        meta: {},
      },
    ];
    const index = await buildMetricIndex(fakeClient(dashboards));
    expect(index.brokenDatasources).toEqual([
      { dashboardUid: 'd1', dashboardTitle: 'Templated dashboard', panelId: 3, datasourceUid: 'Old Datasource Name' },
    ]);
  });

  it('flags a panel a real alert rule is wired to via __dashboardUid__/__panelId__ annotations', async () => {
    const dashboards: DashboardGetResponse[] = [
      {
        dashboard: {
          uid: 'blockstorage',
          title: 'Block Storage',
          panels: [
            { id: 1, title: 'Ceph health', targets: [{ refId: 'A', datasource: { uid: 'prom1' }, expr: 'ceph_health_status' }] },
            { id: 2, title: 'Unrelated panel', targets: [{ refId: 'A', datasource: { uid: 'prom1' }, expr: 'up' }] },
          ],
        },
        meta: {},
      },
    ];
    const ruleGroups: Record<string, RulerRuleGroup[]> = {
      'Product Alerts': [
        {
          name: 'blockstorage-alerts',
          folderUid: 'product-alerts',
          rules: [
            {
              grafana_alert: {
                uid: 'rule1',
                title: 'BlockStorageCephDegraded',
                condition: 'A',
                data: [],
                annotations: { __dashboardUid__: 'blockstorage', __panelId__: '1' },
                labels: { service: 'blockstorage' },
              },
            },
            // No dashboard link at all — a label-only rule, not an error, just skipped.
            { grafana_alert: { uid: 'rule2', title: 'GenericLabelAlert', condition: 'A', data: [] } },
          ],
        },
      ],
    };

    const index = await buildMetricIndex(fakeClient(dashboards, ruleGroups));
    expect(index.alertBackedPanels).toEqual([
      {
        dashboardUid: 'blockstorage',
        dashboardTitle: 'Block Storage',
        panelId: 1,
        panelTitle: 'Ceph health',
        alertRules: [{ uid: 'rule1', title: 'BlockStorageCephDegraded', labels: { service: 'blockstorage' }, folderUid: 'product-alerts' }],
      },
    ]);
  });

  it('does not fail the whole index build when the ruler API is unavailable, but records the error rather than hiding it', async () => {
    const dashboards: DashboardGetResponse[] = [
      { dashboard: { uid: 'd1', title: 'OK', panels: [] }, meta: {} },
    ];
    const client = {
      searchDashboards: async () => [{ uid: 'd1', title: 'OK', type: 'dash-db', tags: [], url: '' }],
      listDatasources: async () => [],
      getRuleGroups: async () => {
        throw new Error('403 Forbidden');
      },
      getDashboard: async () => dashboards[0],
    } as unknown as GrafanaClient;

    const index = await buildMetricIndex(client);
    expect(index.dashboardsScanned).toBe(1);
    expect(index.alertBackedPanels).toEqual([]);
    expect(index.alertRuleAccessError).toBe('403 Forbidden');
  });

  it('leaves alertRuleAccessError undefined when the ruler API succeeds', async () => {
    const dashboards: DashboardGetResponse[] = [{ dashboard: { uid: 'd1', title: 'OK', panels: [] }, meta: {} }];
    const index = await buildMetricIndex(fakeClient(dashboards));
    expect(index.alertRuleAccessError).toBeUndefined();
  });

  it('skips dashboards that fail to load without aborting the whole crawl', async () => {
    const client = {
      searchDashboards: async () => [
        { uid: 'ok', title: 'OK', type: 'dash-db', tags: [], url: '' },
        { uid: 'broken', title: 'Broken', type: 'dash-db', tags: [], url: '' },
      ],
      listDatasources: async () => [],
      getRuleGroups: async () => ({}),
      getDashboard: async (uid: string) => {
        if (uid === 'broken') throw new Error('boom');
        return { dashboard: { uid: 'ok', title: 'OK', panels: [] }, meta: {} };
      },
    } as unknown as GrafanaClient;

    const index = await buildMetricIndex(client);
    expect(index.dashboardsScanned).toBe(1);
  });
});
