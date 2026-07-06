import { describe, expect, it } from 'vitest';
import { findPanel, flattenPanels, resolvePanelQueries } from '../src/dashboards/panelQueries.js';
import type { DashboardJson } from '../src/grafana/types.js';

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
