import { describe, expect, it } from 'vitest';
import { collectAlertRuleAccessErrors, searchIndex } from '../src/tools/findRelatedDashboards.js';
import type { MetricIndex } from '../src/index-builder/store.js';

function index(): MetricIndex {
  return {
    builtAt: new Date(0).toISOString(),
    dashboardsScanned: 2,
    entriesByMetric: {
      ceph_health_status: [
        {
          dashboardUid: 'blockstorage',
          dashboardTitle: 'Block Storage',
          panelId: 1,
          panelTitle: 'Ceph health',
          labels: { service: ['blockstorage'] },
        },
      ],
      http_requests_total: [
        {
          dashboardUid: 'checkout',
          dashboardTitle: 'Checkout overview',
          panelId: 2,
          panelTitle: 'Request rate',
          labels: { service: ['checkout'] },
        },
      ],
    },
    brokenDatasources: [],
    alertBackedPanels: [
      {
        dashboardUid: 'blockstorage',
        dashboardTitle: 'Block Storage',
        panelId: 1,
        panelTitle: 'Ceph health',
        alertRules: [{ uid: 'rule1', title: 'BlockStorageCephDegraded', labels: {} }],
      },
    ],
  };
}

describe('searchIndex', () => {
  it('matches by exact metricName', () => {
    const results = searchIndex(index(), 'conn1', { metricName: 'ceph_health_status' });
    expect(results.map((r) => r.dashboardUid)).toEqual(['blockstorage']);
  });

  it('matches by label overlap', () => {
    const results = searchIndex(index(), 'conn1', { labels: { service: 'checkout' } });
    expect(results.map((r) => r.dashboardUid)).toEqual(['checkout']);
  });

  it('matches a free-text query against the dashboard title, case-insensitively, without an exact metric/label', () => {
    const results = searchIndex(index(), 'conn1', { query: 'block storage' });
    expect(results.map((r) => r.dashboardUid)).toEqual(['blockstorage']);
  });

  it('matches a free-text query against the panel title', () => {
    const results = searchIndex(index(), 'conn1', { query: 'ceph' });
    expect(results.map((r) => r.dashboardUid)).toEqual(['blockstorage']);
  });

  it('matches a free-text query against the metric name itself', () => {
    const results = searchIndex(index(), 'conn1', { query: 'requests_total' });
    expect(results.map((r) => r.dashboardUid)).toEqual(['checkout']);
  });

  it('returns nothing when the query matches no metric name or title', () => {
    const results = searchIndex(index(), 'conn1', { query: 'nonexistent-product' });
    expect(results).toEqual([]);
  });

  it('attaches backingAlertRuleTitles for a panel a real alert rule is wired to, and leaves it empty otherwise', () => {
    const results = searchIndex(index(), 'conn1', { query: 'storage' });
    expect(results).toHaveLength(1);
    expect(results[0]?.backingAlertRuleTitles).toEqual(['BlockStorageCephDegraded']);

    const unbacked = searchIndex(index(), 'conn1', { query: 'checkout' });
    expect(unbacked[0]?.backingAlertRuleTitles).toEqual([]);
  });
});

describe('collectAlertRuleAccessErrors', () => {
  it('includes only connections whose alert-rule crawl actually failed', () => {
    const ok = index();
    const failed = { ...index(), alertRuleAccessError: '403 Forbidden' };
    const errors = collectAlertRuleAccessErrors([
      { connectionId: 'eu-prd', index: ok },
      { connectionId: 'kr-prd', index: failed },
    ]);
    expect(errors).toEqual({ 'kr-prd': '403 Forbidden' });
  });

  it('returns an empty object when every connection\'s crawl succeeded', () => {
    const errors = collectAlertRuleAccessErrors([{ connectionId: 'eu-prd', index: index() }]);
    expect(errors).toEqual({});
  });
});
