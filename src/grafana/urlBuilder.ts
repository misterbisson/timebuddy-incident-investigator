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
/**
 * Builds the full (chrome-included) dashboard/panel URL with Grafana's
 * Inspect drawer pre-opened on the Data tab, via `inspect=<panelId>` +
 * `inspectTab=data`. Grafana syncs the Inspect drawer's open/closed state and
 * active tab to the URL itself, so navigating straight here needs no
 * menu-click chain (hover panel -> open menu -> Inspect -> Data) to reach it.
 * Used by the Electron screenshotter's exportPanelCsv, which drives a real
 * browser to reproduce a panel's Grafana-side transformations exactly -
 * distinct from buildSoloPanelUrl's chrome-free embed (which never renders
 * the panel menu/Inspect drawer at all) and buildDashboardUrl's human-facing
 * link (which doesn't request the drawer open).
 */
export function buildInspectDataUrl(
  baseUrl: string,
  dashboardUid: string,
  panelId: number,
  opts: Omit<DashboardUrlOptions, 'panelId'> = {},
): string {
  const url = new URL(buildDashboardUrl(baseUrl, dashboardUid, { ...opts, panelId }));
  url.searchParams.set('inspect', String(panelId));
  url.searchParams.set('inspectTab', 'data');
  return url.toString();
}

/**
 * Builds a clickable Grafana folder URL (`/dashboards/f/:uid/:slug`) — the
 * folder-browsing counterpart to buildDashboardUrl, for list_folder_dashboards
 * to link back to the folder it just listed. Grafana resolves `/dashboards/f/:uid`
 * by UID alone the same way `/d/:uid` does, so a slugless path still works;
 * pass the folder's own title (slugified) when known for a prettier link.
 */
export function buildFolderUrl(baseUrl: string, folderUid: string, slug?: string): string {
  const path = `/dashboards/f/${encodeURIComponent(folderUid)}${slug ? `/${encodeURIComponent(slug)}` : ''}`;
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export interface ExploreUrlOptions {
  datasourceUid: string;
  datasourceType: string;
  /** The raw query text, exactly as sent to /api/ds/query. */
  query: string;
  fromMs: number;
  toMs: number;
  /** Grafana org the datasource belongs to; omitted rather than defaulted to 1 (see below). */
  orgId?: number;
}

/**
 * Fixed pane key. Grafana generates a random three-character key per pane; a
 * constant one means two Explore URLs for the same query are byte-identical and
 * therefore diffable, which matters when these land in an audit log that someone
 * reads later. Grafana treats the key as opaque, so any stable string works.
 */
const EXPLORE_PANE_KEY = 'timebuddy';

/**
 * Builds a Grafana Explore URL that re-runs one ad-hoc query exactly as
 * execute_adhoc_query ran it — the audit artifact for a query that came from the
 * model rather than from a dashboard. A logged query string tells a human what
 * was asked; this lets them click it and see the same result in the tool they
 * already trust, which is the difference between a record and a reproduction.
 *
 * Same round-trip discipline as buildDashboardUrl above: generate the shape
 * Grafana itself parses, so a URL from here works when pasted back in.
 *
 * Three things this deliberately does NOT do:
 *
 * - **No relative time range.** Grafana's own Explore links happily carry
 *   `"from":"now-1h"`, which makes them describe a *different* window every time
 *   they're opened. For an audit record that's not a cosmetic problem, it's a
 *   record that silently lies the next day, so `fromMs`/`toMs` are always
 *   absolute epoch-ms strings — matching buildDashboardUrl's `from`/`to`.
 * - **No hardcoded `orgId=1`.** A wrong org resolves against the wrong
 *   datasource list. Omitted unless the caller actually knows it, which lets
 *   Grafana fall back to the viewer's own current org.
 * - **No builder-model query.** The pane carries `query` + `rawQuery: true`
 *   (InfluxQL's raw text form), not the measurement/select/groupBy model Grafana
 *   emits from its visual query editor. That's the shape the query was actually
 *   executed in, and reconstructing an equivalent builder model would risk the
 *   link showing something subtly different from what ran.
 *
 * Emits the `schemaVersion=1&panes={...}` form, which is Grafana >= 10.2. On an
 * older instance the link will open Explore without the query pre-filled rather
 * than erroring; there is no Grafana version detection in this client, so that
 * floor is documented rather than detected (see docs/TOOLS.md).
 */
export function buildExploreUrl(baseUrl: string, opts: ExploreUrlOptions): string {
  const pane = {
    datasource: opts.datasourceUid,
    queries: [
      {
        refId: 'A',
        datasource: { type: opts.datasourceType, uid: opts.datasourceUid },
        query: opts.query,
        rawQuery: true,
        resultFormat: 'time_series',
      },
    ],
    // Strings, not numbers: Grafana's Explore state reads absolute bounds as
    // stringified epoch-ms, and a bare number is parsed inconsistently across
    // versions.
    range: { from: String(opts.fromMs), to: String(opts.toMs) },
  };
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/explore`);
  url.searchParams.set('schemaVersion', '1');
  url.searchParams.set('panes', JSON.stringify({ [EXPLORE_PANE_KEY]: pane }));
  if (opts.orgId !== undefined) url.searchParams.set('orgId', String(opts.orgId));
  return url.toString();
}

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
