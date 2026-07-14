const DASHBOARD_LINK_RE = /\/d\/([A-Za-z0-9_-]+)/g;

/**
 * Best-effort extraction of dashboard uids referenced anywhere inside a
 * knowledge panel's freeform `json` block (e.g. links.opsDashboard/
 * sliDashboard, each sli.<plane>.dependencies[].url) — used to scope
 * detect_correlated_anomalies's "product" tier to the dashboards a team has
 * actually declared belong to this product, rather than guessing from folder
 * structure. Walks every string value recursively rather than looking for
 * specific keys, since this JSON has no fixed schema — it's whatever the
 * publishing team chose to write. A non-dashboard link (a wiki/docs url with
 * no "/d/<uid>" segment) simply contributes nothing, not an error.
 */
export function extractRelatedDashboardUids(json: unknown): string[] {
  const uids = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(DASHBOARD_LINK_RE)) uids.add(match[1]!);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(json);
  return [...uids];
}
