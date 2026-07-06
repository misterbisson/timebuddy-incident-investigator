import { describe, expect, it } from 'vitest';
import { buildMetricIndex } from '../src/index-builder/metricIndex.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { DashboardGetResponse } from '../src/grafana/types.js';

function fakeClient(dashboards: DashboardGetResponse[]): GrafanaClient {
  const byUid = new Map(dashboards.map((d) => [d.dashboard.uid, d]));
  return {
    searchDashboards: async () => dashboards.map((d) => ({ uid: d.dashboard.uid, title: d.dashboard.title, type: 'dash-db', tags: [], url: '' })),
    listDatasources: async () => [{ uid: 'prom1', id: 1, name: 'Prometheus', type: 'prometheus' }],
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

  it('skips dashboards that fail to load without aborting the whole crawl', async () => {
    const client = {
      searchDashboards: async () => [
        { uid: 'ok', title: 'OK', type: 'dash-db', tags: [], url: '' },
        { uid: 'broken', title: 'Broken', type: 'dash-db', tags: [], url: '' },
      ],
      listDatasources: async () => [],
      getDashboard: async (uid: string) => {
        if (uid === 'broken') throw new Error('boom');
        return { dashboard: { uid: 'ok', title: 'OK', panels: [] }, meta: {} };
      },
    } as unknown as GrafanaClient;

    const index = await buildMetricIndex(client);
    expect(index.dashboardsScanned).toBe(1);
  });
});
