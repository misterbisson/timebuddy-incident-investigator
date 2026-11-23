import { describe, expect, it } from 'vitest';
import { selectProductCandidates } from '../src/analysis/productScope.js';
import type { ResolvedPanel } from '../src/dashboards/panelQueries.js';

function panel(panelId: number, extra: Partial<ResolvedPanel> = {}): ResolvedPanel {
  return { panelId, title: `panel ${panelId}`, targets: [], dataLinks: [], ...extra };
}

const noPriority = () => 0;

describe('selectProductCandidates', () => {
  it('takes panels round-robin across dashboards, in the order given', () => {
    const { candidates } = selectProductCandidates(
      [
        { dashboardUid: 'a', panels: [panel(1), panel(2), panel(3)] },
        { dashboardUid: 'b', panels: [panel(10)] },
        { dashboardUid: 'c', panels: [panel(20), panel(21)] },
      ],
      { cap: 5, exclude: { dashboardUid: 'none', panelId: 0 }, prioritize: noPriority },
    );
    expect(candidates.map((c) => `${c.dashboardUid}/${c.panelId}`)).toEqual(['a/1', 'b/10', 'c/20', 'a/2', 'c/21']);
  });

  it('orders panels within a dashboard by priority, keeping dashboard order on ties', () => {
    const { candidates } = selectProductCandidates([{ dashboardUid: 'a', panels: [panel(1), panel(2), panel(3), panel(4)] }], {
      cap: 10,
      exclude: { dashboardUid: 'none', panelId: 0 },
      prioritize: (_uid, p) => (p.panelId === 3 ? 0 : p.panelId === 4 ? 1 : 2),
    });
    expect(candidates.map((c) => c.panelId)).toEqual([3, 4, 1, 2]);
  });

  it('excludes the primary panel and mirror panels, and does not count them as queryable', () => {
    const { candidates, dashboards } = selectProductCandidates(
      [{ dashboardUid: 'p', dashboardTitle: 'P', panels: [panel(1), panel(2), panel(3, { mirrorsPanelIds: [2] })] }],
      { cap: 10, exclude: { dashboardUid: 'p', panelId: 1 }, prioritize: noPriority },
    );
    expect(candidates).toEqual([{ dashboardUid: 'p', panelId: 2 }]);
    expect(dashboards).toEqual([{ dashboardUid: 'p', dashboardTitle: 'P', queryablePanels: 1, checked: 1 }]);
  });

  it('names panels whose id is shared, and excludes only the primary among them', () => {
    const { candidates } = selectProductCandidates(
      [{ dashboardUid: 'p', panels: [panel(9, { title: 'Compute' }), panel(9, { title: 'Storage' }), panel(5)] }],
      { cap: 10, exclude: { dashboardUid: 'p', panelId: 9, panelTitle: 'Compute' }, prioritize: noPriority },
    );
    expect(candidates).toEqual([
      { dashboardUid: 'p', panelId: 9, panelTitle: 'Storage' },
      { dashboardUid: 'p', panelId: 5 },
    ]);
  });

  it('reports panels left out by the cap and dashboards that could not be read', () => {
    const { dashboards } = selectProductCandidates(
      [
        { dashboardUid: 'a', panels: [panel(1), panel(2), panel(3)] },
        { dashboardUid: 'gone', error: 'not found' },
      ],
      { cap: 1, exclude: { dashboardUid: 'none', panelId: 0 }, prioritize: noPriority },
    );
    expect(dashboards).toEqual([
      { dashboardUid: 'a', queryablePanels: 3, checked: 1, uncheckedPanelIds: [2, 3] },
      { dashboardUid: 'gone', queryablePanels: 0, checked: 0, error: 'not found' },
    ]);
  });
});
