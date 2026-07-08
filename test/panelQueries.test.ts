import { describe, expect, it } from 'vitest';
import { AmbiguousPanelError, findPanel, flattenPanels, resolvePanelDataLinks, resolvePanelQueries } from '../src/dashboards/panelQueries.js';
import type { DashboardJson, Panel } from '../src/grafana/types.js';

describe('flattenPanels', () => {
  it('flattens row panels into their nested children', () => {
    const flat = flattenPanels([
      { id: 1, type: 'row', panels: [{ id: 2, title: 'Nested', targets: [{ refId: 'A' }] }] },
      { id: 3, title: 'Top-level' },
    ]);
    expect(flat.map((p) => p.id)).toEqual([2, 3]);
  });
});

describe('resolvePanelQueries', () => {
  const dashboard: DashboardJson = {
    uid: 'd1',
    title: 'Test',
    panels: [
      { id: 1, title: 'No targets' },
      {
        id: 2,
        title: 'Prometheus panel',
        datasource: { uid: 'prom1' },
        targets: [{ refId: 'A', expr: 'up' }],
      },
      {
        id: 3,
        title: 'Mixed panel',
        datasource: '-- Mixed --',
        targets: [{ refId: 'A', datasource: { uid: 'influx1' }, query: 'SELECT 1' }],
      },
    ],
  };

  it('only returns panels that have targets', () => {
    const resolved = resolvePanelQueries(dashboard);
    expect(resolved.map((p) => p.panelId)).toEqual([2, 3]);
  });

  it('resolves the target datasource from the panel-level datasource when the target has none', () => {
    const resolved = resolvePanelQueries(dashboard);
    expect(resolved.find((p) => p.panelId === 2)?.targets[0]?.datasourceUid).toBe('prom1');
  });

  it('resolves per-target datasource for a mixed-datasource panel', () => {
    const resolved = resolvePanelQueries(dashboard);
    expect(resolved.find((p) => p.panelId === 3)?.targets[0]?.datasourceUid).toBe('influx1');
  });

  it('findPanel returns undefined for an unknown panel id', () => {
    expect(findPanel(dashboard, 999)).toBeUndefined();
  });

  it('findPanel returns the matching panel', () => {
    expect(findPanel(dashboard, 2)?.title).toBe('Prometheus panel');
  });
});

describe('findPanel with duplicate panel ids', () => {
  // Confirmed against a real dashboard: a provisioning bug (no Grafana
  // `repeat` field) stamped ~24 genuinely different panels, one per product,
  // all sharing id 9.
  const dashboard: DashboardJson = {
    uid: 'd1',
    title: 'Test',
    panels: [
      { id: 9, title: 'Block Storage API success averages', datasource: { uid: 'prom1' }, targets: [{ refId: 'A', expr: 'up' }] },
      { id: 9, title: 'Compute API success averages', datasource: { uid: 'prom1' }, targets: [{ refId: 'A', expr: 'up' }] },
    ],
  };

  it('throws AmbiguousPanelError instead of silently returning the first match', () => {
    expect(() => findPanel(dashboard, 9)).toThrow(AmbiguousPanelError);
  });

  it('lists every candidate title in the error message', () => {
    try {
      findPanel(dashboard, 9);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousPanelError);
      expect((err as Error).message).toContain('Block Storage API success averages');
      expect((err as Error).message).toContain('Compute API success averages');
    }
  });

  it('resolves to the right panel when panelTitle disambiguates', () => {
    expect(findPanel(dashboard, 9, 'Compute API success averages')?.title).toBe('Compute API success averages');
  });

  it('still throws when panelTitle does not match any candidate', () => {
    expect(() => findPanel(dashboard, 9, 'Nonexistent product')).toThrow(AmbiguousPanelError);
  });
});

describe('resolvePanelQueries with Grafana\'s built-in "-- Dashboard --" datasource', () => {
  // Confirmed against real dashboards: a stat panel set to mirror another
  // panel's already-computed value has no backend to query — replaying it
  // through /api/ds/query always 404s ("data source not found"), which reads
  // like a broken dashboard but is this Grafana feature working as designed.
  const dashboard: DashboardJson = {
    uid: 'd1',
    title: 'Test',
    panels: [
      { id: 4, title: 'Success rate over time', datasource: { uid: 'influx1' }, targets: [{ refId: 'A', query: 'SELECT mean("success")' }] },
      {
        id: 6,
        title: 'Success rate (stat)',
        datasource: { uid: '-- Dashboard --' },
        targets: [{ refId: 'A', panelId: 4 }],
      },
    ],
  };

  it('flags a panel whose target mirrors another panel via the "-- Dashboard --" datasource', () => {
    const resolved = resolvePanelQueries(dashboard);
    const mirror = resolved.find((p) => p.panelId === 6);
    expect(mirror?.mirrorsPanelIds).toEqual([4]);
  });

  it('does not flag a normally-queried panel', () => {
    const resolved = resolvePanelQueries(dashboard);
    const normal = resolved.find((p) => p.panelId === 4);
    expect(normal?.mirrorsPanelIds).toBeUndefined();
  });
});

describe('resolvePanelDataLinks', () => {
  it('returns an empty array when the panel has no fieldConfig', () => {
    const panel: Panel = { id: 1, title: 'No links' };
    expect(resolvePanelDataLinks(panel)).toEqual([]);
  });

  it('extracts a default link, which applies to every field', () => {
    const panel: Panel = {
      id: 1,
      title: 'Table',
      fieldConfig: { defaults: { links: [{ title: 'Explore', url: '/explore?left=${__value.raw}' }] } },
    };
    expect(resolvePanelDataLinks(panel)).toEqual([{ title: 'Explore', url: '/explore?left=${__value.raw}' }]);
  });

  // Confirmed against a real dashboard's "Impacted customers by error count"
  // panel: a byName override on a field named "Field" carrying a "links"
  // property, pointing at a per-account drill-down dashboard.
  it('extracts a field-scoped link from a byName fieldConfig override', () => {
    const panel: Panel = {
      id: 1,
      title: 'Impacted customers by error count',
      fieldConfig: {
        overrides: [
          {
            matcher: { id: 'byName', options: 'Field' },
            properties: [
              {
                id: 'links',
                value: [
                  {
                    title: 'Show results for customer',
                    url: '/d/product-status-customer-usage-impact?from=${__from}&to=${__to}&var-account_id=${__data.fields["Field"]}',
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(resolvePanelDataLinks(panel)).toEqual([
      {
        title: 'Show results for customer',
        url: '/d/product-status-customer-usage-impact?from=${__from}&to=${__to}&var-account_id=${__data.fields["Field"]}',
        appliesToField: 'Field',
      },
    ]);
  });

  it('ignores overrides with no links property', () => {
    const panel: Panel = {
      id: 1,
      title: 'Table',
      fieldConfig: {
        overrides: [{ matcher: { id: 'byName', options: 'Field' }, properties: [{ id: 'unit', value: 'bytes' }] }],
      },
    };
    expect(resolvePanelDataLinks(panel)).toEqual([]);
  });

  it('includes dataLinks on every panel returned by resolvePanelQueries', () => {
    const dashboard: DashboardJson = {
      uid: 'd1',
      title: 'Test',
      panels: [
        {
          id: 1,
          title: 'Table',
          targets: [{ refId: 'A', expr: 'up' }],
          fieldConfig: { defaults: { links: [{ title: 'Explore', url: '/explore' }] } },
        },
      ],
    };
    expect(resolvePanelQueries(dashboard)[0]?.dataLinks).toEqual([{ title: 'Explore', url: '/explore' }]);
  });
});
