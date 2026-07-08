export interface DashboardUrlOptions {
  panelId?: number;
  fromMs?: number;
  toMs?: number;
  variables?: Record<string, string[]>;
}

/**
 * Builds a clickable Grafana dashboard/panel URL so a human reading a tool
 * result can jump straight to it, at the right time window, instead of
 * having to manually reconstruct one from a bare dashboardUid/panelId. Uses
 * "viewPanel" (not the older "panelId&fullscreen" form) since that's the
 * param urlParser.ts itself checks first when parsing an *incoming* link —
 * generating and parsing agree, so a URL built here round-trips correctly
 * through get_alert_context if it's ever pasted back in.
 *
 * Deliberately doesn't need the dashboard's slug — Grafana resolves /d/:uid
 * by UID alone and redirects to the canonical slug itself, so a bare UID
 * path is a real, working link, just without a pretty title in the path.
 */
export function buildDashboardUrl(baseUrl: string, dashboardUid: string, opts: DashboardUrlOptions = {}): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/d/${encodeURIComponent(dashboardUid)}`);
  if (opts.panelId !== undefined) url.searchParams.set('viewPanel', String(opts.panelId));
  if (opts.fromMs !== undefined) url.searchParams.set('from', String(opts.fromMs));
  if (opts.toMs !== undefined) url.searchParams.set('to', String(opts.toMs));
  if (opts.variables) {
    for (const [name, values] of Object.entries(opts.variables)) {
      for (const value of values) url.searchParams.append(`var-${name}`, value);
    }
  }
  return url.toString();
}

/**
 * Builds a Grafana "solo panel" embed URL (/d-solo/:uid) — the same
 * chrome-free, single-panel view Grafana's own (optional) Image Renderer
 * plugin navigates to internally — for screenshot_panel's headless-browser
 * capture. Deliberately distinct from buildDashboardUrl's "viewPanel" form
 * (the human-facing clickable link): that one shows the full dashboard with
 * one panel expanded, not an isolated render suitable for a clean screenshot.
 */
export function buildSoloPanelUrl(
  baseUrl: string,
  dashboardUid: string,
  panelId: number,
  opts: Omit<DashboardUrlOptions, 'panelId'> = {},
): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/d-solo/${encodeURIComponent(dashboardUid)}`);
  url.searchParams.set('panelId', String(panelId));
  if (opts.fromMs !== undefined) url.searchParams.set('from', String(opts.fromMs));
  if (opts.toMs !== undefined) url.searchParams.set('to', String(opts.toMs));
  if (opts.variables) {
    for (const [name, values] of Object.entries(opts.variables)) {
      for (const value of values) url.searchParams.append(`var-${name}`, value);
    }
  }
  return url.toString();
}
