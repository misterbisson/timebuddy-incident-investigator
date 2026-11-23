import type { ResolvedPanel } from '../dashboards/panelQueries.js';

/** One panel chosen for the "product" tier. `panelTitle` is set only when the panel's id is shared with another panel on its dashboard. */
export interface ProductCandidate {
  dashboardUid: string;
  panelId: number;
  panelTitle?: string;
}

/** One dashboard in the product tier: its queryable panels in priority order, or why they couldn't be read. */
export type ProductDashboardInput =
  | { dashboardUid: string; dashboardTitle?: string; panels: ResolvedPanel[] }
  | { dashboardUid: string; error: string };

/** What the product tier did with one dashboard, as reported in `productScope.dashboards`. */
export interface ProductDashboardReport {
  dashboardUid: string;
  dashboardTitle?: string;
  /** Panels on this dashboard that have a query to run (mirror panels and the primary panel itself excluded). */
  queryablePanels: number;
  /** How many of those this call compared. */
  checked: number;
  /** Of `checked`, how many couldn't be compared because their query or dashboard read failed. Set by the caller after running them. */
  failed?: number;
  /** Set when some of this dashboard's panels were left out by the per-call cap: pass them as explicit `candidates` to compare them. */
  uncheckedPanelIds?: number[];
  /** Set when the dashboard itself couldn't be read, so none of its panels were compared. */
  error?: string;
}

/**
 * Picks the "product" tier's candidates (issue #310): every queryable panel on
 * every dashboard the product tier lists, not only panels that share the
 * primary's metric. A dependency dashboard is listed because the knowledge
 * panel says it matters to this product, and its panels almost never use the
 * primary's metric, so requiring a shared metric left the dependency half of
 * the tier empty while `productScope` still listed those dashboards.
 *
 * The per-call cap is shared round-robin across dashboards, in the order
 * given (primary first), so one large board can't use up the whole budget
 * before a dependency gets a single panel. Within a dashboard, `prioritize`
 * decides which panels go first; whatever doesn't fit is reported per
 * dashboard rather than dropped silently.
 */
export function selectProductCandidates(
  dashboards: ProductDashboardInput[],
  { cap, exclude, prioritize }: {
    cap: number;
    /** The primary panel, which is never its own candidate. */
    exclude: { dashboardUid: string; panelId: number; panelTitle?: string };
    /** Lower sorts first; ties keep dashboard order. */
    prioritize: (dashboardUid: string, panel: ResolvedPanel) => number;
  },
): { candidates: ProductCandidate[]; dashboards: ProductDashboardReport[] } {
  const queues = dashboards.map((d) => {
    if ('error' in d) return { dashboard: d, queue: [] as ProductCandidate[] };
    const idCounts = new Map<number, number>();
    for (const p of d.panels) idCounts.set(p.panelId, (idCounts.get(p.panelId) ?? 0) + 1);
    const queue = d.panels
      .filter((p) => !p.mirrorsPanelIds)
      .filter(
        (p) =>
          !(
            d.dashboardUid === exclude.dashboardUid &&
            p.panelId === exclude.panelId &&
            (idCounts.get(p.panelId)! === 1 || exclude.panelTitle === undefined || p.title === exclude.panelTitle)
          ),
      )
      .map((p, order) => ({ p, order, rank: prioritize(d.dashboardUid, p) }))
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .map(({ p }) => ({
        dashboardUid: d.dashboardUid,
        panelId: p.panelId,
        ...(idCounts.get(p.panelId)! > 1 && p.title ? { panelTitle: p.title } : {}),
      }));
    return { dashboard: d, queue };
  });

  const taken = queues.map(() => 0);
  const candidates: ProductCandidate[] = [];
  for (let progressed = true; progressed && candidates.length < cap; ) {
    progressed = false;
    for (let i = 0; i < queues.length && candidates.length < cap; i += 1) {
      const next = queues[i]!.queue[taken[i]!];
      if (!next) continue;
      candidates.push(next);
      taken[i]! += 1;
      progressed = true;
    }
  }

  const reports = queues.map(({ dashboard, queue }, i): ProductDashboardReport => {
    if ('error' in dashboard) return { dashboardUid: dashboard.dashboardUid, queryablePanels: 0, checked: 0, error: dashboard.error };
    const unchecked = queue.slice(taken[i]!).map((c) => c.panelId);
    return {
      dashboardUid: dashboard.dashboardUid,
      ...(dashboard.dashboardTitle !== undefined ? { dashboardTitle: dashboard.dashboardTitle } : {}),
      queryablePanels: queue.length,
      checked: taken[i]!,
      ...(unchecked.length > 0 ? { uncheckedPanelIds: unchecked } : {}),
    };
  });
  return { candidates, dashboards: reports };
}
