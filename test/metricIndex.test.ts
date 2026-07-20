import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMetricIndex, getCachedIndexIfFresh, getOrBuildIndex, SEARCH_PAGE_SIZE } from '../src/index-builder/metricIndex.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { Config } from '../src/config.js';
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

  it('captures per-dashboard recency/authorship from meta.updated/updatedBy/created/createdBy', async () => {
    const dashboards: DashboardGetResponse[] = [
      {
        dashboard: { uid: 'd1', title: 'Checkout overview', panels: [] },
        meta: { updated: '2024-06-01T00:00:00.000Z', updatedBy: 'alice', created: '2024-01-01T00:00:00.000Z', createdBy: 'bob' },
      },
    ];
    const index = await buildMetricIndex(fakeClient(dashboards));
    expect(index.dashboardMeta.d1).toEqual({
      title: 'Checkout overview',
      updatedAt: '2024-06-01T00:00:00.000Z',
      updatedBy: 'alice',
      createdAt: '2024-01-01T00:00:00.000Z',
      createdBy: 'bob',
    });
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
              // annotations/labels are siblings of grafana_alert in the real
              // ruler API response, not fields on it — see RulerRuleGroup.
              grafana_alert: { uid: 'rule1', title: 'BlockStorageCephDegraded', condition: 'A', data: [] },
              annotations: { __dashboardUid__: 'blockstorage', __panelId__: '1' },
              labels: { service: 'blockstorage' },
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

  it('does not read annotations/labels off grafana_alert itself, only off the rule wrapper', async () => {
    const dashboards: DashboardGetResponse[] = [
      { dashboard: { uid: 'd1', title: 'D1', panels: [{ id: 1, title: 'P1', targets: [] }] }, meta: {} },
    ];
    const ruleGroups: Record<string, RulerRuleGroup[]> = {
      folder: [
        {
          name: 'group',
          folderUid: 'f1',
          rules: [
            {
              // Misplaced, as if grafana_alert carried them directly (the
              // real bug this guards against) — must NOT be picked up.
              grafana_alert: {
                uid: 'rule1',
                title: 'Misplaced',
                condition: 'A',
                data: [],
                annotations: { __dashboardUid__: 'd1', __panelId__: '1' },
              } as unknown as RulerRuleGroup['rules'][number]['grafana_alert'],
            },
          ],
        },
      ],
    };
    const index = await buildMetricIndex(fakeClient(dashboards, ruleGroups));
    expect(index.alertBackedPanels).toEqual([]);
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
    // The fetch failure is visible as the discovered/scanned gap, not swallowed.
    expect(index.dashboardsScanned).toBe(1);
    expect(index.dashboardsDiscovered).toBe(2);
  });
});

describe('buildMetricIndex — enumerating the estate', () => {
  it('pages through /api/search so an estate larger than one page is fully scanned', async () => {
    // One full page plus a short second page, at the real SEARCH_PAGE_SIZE, so
    // the "keep going after a full page, stop after a short one" logic runs.
    const total = SEARCH_PAGE_SIZE + 2;
    const uids = Array.from({ length: total }, (_, i) => `d${i}`);
    const searchDashboards = vi.fn(async ({ page = 1, limit = SEARCH_PAGE_SIZE }: { page?: number; limit?: number } = {}) => {
      const start = (page - 1) * limit;
      return uids.slice(start, start + limit).map((uid) => ({ uid, title: uid, type: 'dash-db', tags: [], url: '' }));
    });
    const client = {
      searchDashboards,
      getDashboard: vi.fn(async (uid: string) => ({ dashboard: { uid, title: uid, panels: [] }, meta: {} })),
      listDatasources: async () => [],
      getRuleGroups: async () => ({}),
    } as unknown as GrafanaClient;

    const index = await buildMetricIndex(client);
    expect(index.dashboardsScanned).toBe(total);
    expect(index.dashboardsDiscovered).toBe(total);
    // page 1 (full) → page 2 (short, stop). Exactly two search calls.
    expect(searchDashboards).toHaveBeenCalledTimes(2);
  });

  it('makes a single search call for an estate that fits in one page', async () => {
    const searchDashboards = vi.fn(async () => [{ uid: 'd0', title: 'd0', type: 'dash-db', tags: [], url: '' }]);
    const client = {
      searchDashboards,
      getDashboard: vi.fn(async (uid: string) => ({ dashboard: { uid, title: uid, panels: [] }, meta: {} })),
      listDatasources: async () => [],
      getRuleGroups: async () => ({}),
    } as unknown as GrafanaClient;

    await buildMetricIndex(client);
    expect(searchDashboards).toHaveBeenCalledTimes(1);
  });

  it('stops paging when a full page repeats uids it has already seen (server ignores `page`)', async () => {
    // A server that returns the SAME *full* page regardless of `page` never
    // trips the short-page stop, so it would loop forever on a naive "keep
    // going until a short page" — the dedup guard (no fresh uids) is what stops it.
    const fullPage = Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) => ({
      uid: `d${i}`,
      title: `d${i}`,
      type: 'dash-db',
      tags: [],
      url: '',
    }));
    const searchDashboards = vi.fn(async () => fullPage);
    const client = {
      searchDashboards,
      getDashboard: vi.fn(async (uid: string) => ({ dashboard: { uid, title: uid, panels: [] }, meta: {} })),
      listDatasources: async () => [],
      getRuleGroups: async () => ({}),
    } as unknown as GrafanaClient;

    const index = await buildMetricIndex(client);
    expect(index.dashboardsScanned).toBe(SEARCH_PAGE_SIZE); // deduped, not growing per page
    // page 1 (all fresh) → page 2 (all seen → stop). Two calls, not unbounded.
    expect(searchDashboards).toHaveBeenCalledTimes(2);
  });

  it('dedups a uid that appears on more than one page', async () => {
    const searchDashboards = vi.fn(async ({ page = 1 }: { page?: number } = {}) => {
      // page 1 and page 2 both include 'shared'; page 2 is short so paging stops.
      if (page === 1) return [{ uid: 'shared', title: 's', type: 'dash-db', tags: [], url: '' }];
      return [];
    });
    const client = {
      searchDashboards,
      getDashboard: vi.fn(async (uid: string) => ({ dashboard: { uid, title: uid, panels: [] }, meta: {} })),
      listDatasources: async () => [],
      getRuleGroups: async () => ({}),
    } as unknown as GrafanaClient;

    const index = await buildMetricIndex(client);
    expect(index.dashboardsScanned).toBe(1);
  });

  it('never holds more than `maxConcurrency` dashboard responses in memory at once', async () => {
    // The retention bug this guards against: the previous code created one
    // getDashboard promise per dashboard up front and kept every resolved
    // response alive until the last settled. The pool bounds concurrent
    // executions to maxConcurrency, so no more than that many responses are
    // ever live at once. A small real delay lets executions overlap so the
    // measured peak reflects the cap, not sequential timing.
    const uids = Array.from({ length: 20 }, (_, i) => `d${i}`);
    const searchDashboards = async () => uids.map((uid) => ({ uid, title: uid, type: 'dash-db', tags: [], url: '' }));

    let inFlight = 0;
    let peakInFlight = 0;
    const getDashboard = vi.fn(async (uid: string) => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { dashboard: { uid, title: uid, panels: [] }, meta: {} };
    });
    const client = {
      searchDashboards,
      getDashboard,
      listDatasources: async () => [],
      getRuleGroups: async () => ({}),
    } as unknown as GrafanaClient;

    const index = await buildMetricIndex(client, { maxConcurrency: 3 } as unknown as Config);

    expect(index.dashboardsScanned).toBe(20);
    expect(getDashboard).toHaveBeenCalledTimes(20);
    expect(peakInFlight).toBe(3); // exactly the cap, proving overlap actually occurred
  });
});

describe('getOrBuildIndex / getCachedIndexIfFresh', () => {
  let dataDir: string;

  function config(): Config {
    return {
      connections: [],
      tlsVerify: true,
      requestTimeoutMs: 1000,
      screenshotTimeoutMs: 45000,
      maxConcurrency: 4,
      maxLookbackHours: 720,
      maxDataPoints: 2000,
      redactionPatterns: [],
      dataDir,
      webhookPort: 4318,
    };
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'get-or-build-index-test-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function fakeClient(): { client: GrafanaClient; getDashboard: ReturnType<typeof vi.fn> } {
    const getDashboard = vi.fn(async (uid: string) => ({ dashboard: { uid, title: uid, panels: [] }, meta: {} }));
    const client = {
      searchDashboards: async () => [{ uid: 'd1', title: 'D1', type: 'dash-db', tags: [], url: '' }],
      listDatasources: async () => [],
      getRuleGroups: async () => ({}),
      getDashboard,
    } as unknown as GrafanaClient;
    return { client, getDashboard };
  }

  it('builds and persists on a cache miss, then reuses the cached copy without re-crawling', async () => {
    const { client, getDashboard } = fakeClient();
    const first = await getOrBuildIndex(client, config(), 'conn1', {});
    expect(first.dashboardsScanned).toBe(1);
    expect(getDashboard).toHaveBeenCalledTimes(1);

    const second = await getOrBuildIndex(client, config(), 'conn1', {});
    expect(second).toEqual(first);
    expect(getDashboard).toHaveBeenCalledTimes(1); // not called again - served from disk cache
  });

  it('coalesces concurrent cache-miss builds into one crawl per connection', async () => {
    // The race in #72: two tools called back-to-back against a cold cache each
    // start a full multi-minute crawl and then both write the same file.
    let searchCalls = 0;
    let releaseSearch: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    const getDashboard = vi.fn(async (uid: string) => ({ dashboard: { uid, title: uid, panels: [] }, meta: {} }));
    const client = {
      // Block the first crawl inside searchDashboards so the second call
      // arrives while the first is still in flight.
      searchDashboards: vi.fn(async () => {
        searchCalls++;
        await gate;
        return [{ uid: 'd1', title: 'D1', type: 'dash-db', tags: [], url: '' }];
      }),
      listDatasources: async () => [],
      getRuleGroups: async () => ({}),
      getDashboard,
    } as unknown as GrafanaClient;

    const a = getOrBuildIndex(client, config(), 'conn1', {});
    const b = getOrBuildIndex(client, config(), 'conn1', {});
    releaseSearch();
    const [ra, rb] = await Promise.all([a, b]);

    expect(searchCalls).toBe(1); // one crawl, not two
    expect(getDashboard).toHaveBeenCalledTimes(1);
    expect(ra).toEqual(rb);
  });

  it('starts a fresh crawl on the next miss after the in-flight one settles', async () => {
    // The coalescing map must clear when a build finishes, or a later miss
    // would return a stale resolved promise instead of rebuilding.
    const { client, getDashboard } = fakeClient();
    await getOrBuildIndex(client, config(), 'conn1', { force: true });
    await getOrBuildIndex(client, config(), 'conn1', { force: true });
    expect(getDashboard).toHaveBeenCalledTimes(2);
  });

  it('builds different connections in parallel rather than serializing them', async () => {
    const { client } = fakeClient();
    const [r1, r2] = await Promise.all([
      getOrBuildIndex(client, config(), 'connA', {}),
      getOrBuildIndex(client, config(), 'connB', {}),
    ]);
    expect(r1.dashboardsScanned).toBe(1);
    expect(r2.dashboardsScanned).toBe(1);
  });

  it('getCachedIndexIfFresh never triggers a build - undefined on a miss, the cached copy once one exists', async () => {
    const { client, getDashboard } = fakeClient();
    expect(await getCachedIndexIfFresh(config(), 'conn1')).toBeUndefined();
    expect(getDashboard).not.toHaveBeenCalled();

    const built = await getOrBuildIndex(client, config(), 'conn1', {});
    expect(await getCachedIndexIfFresh(config(), 'conn1')).toEqual(built);
  });
});
