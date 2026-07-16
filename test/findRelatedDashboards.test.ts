import { describe, expect, it } from 'vitest';
import { collectAlertRuleAccessErrors, compareCandidates, searchIndex, type Candidate } from '../src/tools/findRelatedDashboards.js';
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
    dashboardMeta: {
      blockstorage: { title: 'Block Storage', updatedAt: '2024-06-01T00:00:00.000Z', updatedBy: 'alice' },
      checkout: { title: 'Checkout overview', updatedAt: '2024-01-01T00:00:00.000Z', updatedBy: 'bob' },
    },
  };
}

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    dashboardUid: 'd',
    dashboardTitle: 'D',
    panelId: 1,
    labels: {},
    labelOverlapCount: 0,
    connectionId: 'conn1',
    backingAlertRuleTitles: [],
    ...overrides,
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

  it('attaches updatedAt/updatedBy from the index\'s per-dashboard dashboardMeta', () => {
    const results = searchIndex(index(), 'conn1', { query: 'storage' });
    expect(results[0]).toMatchObject({ updatedAt: '2024-06-01T00:00:00.000Z', updatedBy: 'alice' });
  });

  it('attaches backingAlertRuleTitles for a panel a real alert rule is wired to, and leaves it empty otherwise', () => {
    const results = searchIndex(index(), 'conn1', { query: 'storage' });
    expect(results).toHaveLength(1);
    expect(results[0]?.backingAlertRuleTitles).toEqual(['BlockStorageCephDegraded']);

    const unbacked = searchIndex(index(), 'conn1', { query: 'checkout' });
    expect(unbacked[0]?.backingAlertRuleTitles).toEqual([]);
  });
});

describe('compareCandidates', () => {
  it('still ranks alert-backed above non-alert-backed regardless of recency or authorship', () => {
    const stale = candidate({ dashboardUid: 'old', backingAlertRuleTitles: ['A'], updatedAt: '2020-01-01T00:00:00.000Z' });
    const fresh = candidate({ dashboardUid: 'new', backingAlertRuleTitles: [], updatedAt: '2024-01-01T00:00:00.000Z' });
    expect([fresh, stale].sort((a, b) => compareCandidates(a, b))).toEqual([stale, fresh]);
  });

  it('still ranks higher label overlap above recency or authorship', () => {
    const lowOverlapButFresh = candidate({ dashboardUid: 'a', labelOverlapCount: 1, updatedAt: '2024-01-01T00:00:00.000Z' });
    const highOverlapButStale = candidate({ dashboardUid: 'b', labelOverlapCount: 2, updatedAt: '2020-01-01T00:00:00.000Z' });
    expect([lowOverlapButFresh, highOverlapButStale].sort((a, b) => compareCandidates(a, b))).toEqual([
      highOverlapButStale,
      lowOverlapButFresh,
    ]);
  });

  it('breaks an otherwise-tied comparison by preferring the more recently updated dashboard', () => {
    const older = candidate({ dashboardUid: 'old', updatedAt: '2020-01-01T00:00:00.000Z' });
    const newer = candidate({ dashboardUid: 'new', updatedAt: '2024-01-01T00:00:00.000Z' });
    expect([older, newer].sort((a, b) => compareCandidates(a, b))).toEqual([newer, older]);
  });

  it('prefers a match last updated by the same author as the reference dashboard, ahead of recency', () => {
    const staleSameAuthor = candidate({ dashboardUid: 'same-author', updatedBy: 'alice', updatedAt: '2020-01-01T00:00:00.000Z' });
    const freshOtherAuthor = candidate({ dashboardUid: 'other-author', updatedBy: 'bob', updatedAt: '2024-01-01T00:00:00.000Z' });
    expect([freshOtherAuthor, staleSameAuthor].sort((a, b) => compareCandidates(a, b, 'alice'))).toEqual([
      staleSameAuthor,
      freshOtherAuthor,
    ]);
  });

  it('ignores authorship entirely when no referenceAuthor is given', () => {
    const a = candidate({ dashboardUid: 'a', updatedBy: 'alice', updatedAt: '2020-01-01T00:00:00.000Z' });
    const b = candidate({ dashboardUid: 'b', updatedBy: 'bob', updatedAt: '2024-01-01T00:00:00.000Z' });
    expect([a, b].sort((x, y) => compareCandidates(x, y))).toEqual([b, a]);
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
