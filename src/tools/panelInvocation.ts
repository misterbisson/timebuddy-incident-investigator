import type { Config, GrafanaConnection } from '../config.js';
import type { GrafanaClient } from '../grafana/client.js';
import type { ConnectionRegistry } from '../grafana/registry.js';
import type { DashboardJson, DsQueryRequest, GrafanaFrame } from '../grafana/types.js';
import type { ResolvedPanel, ResolvedTarget } from '../dashboards/panelQueries.js';
import type { Screenshotter } from '../screenshot/types.js';
import { parseGrafanaUrl } from '../alerts/urlParser.js';
import { findPanel } from '../dashboards/panelQueries.js';
import { mergeVariableOverrides, substituteTargetFields } from '../dashboards/variables.js';
import { buildDsQueryTarget, executeQueryWindow } from '../query/executor.js';
import {
  clampMaxDataPoints,
  clampScreenshotDimension,
  enforceWindowLimit,
  MAX_SCREENSHOT_PX,
  MIN_SCREENSHOT_PX,
} from '../security/limits.js';
import { buildSeriesColumnNames, frameToCsv, neutralizeCsvDocument, neutralizeFormula, seriesToCsv } from '../export/csv.js';
import { buildAuthHeader } from '../grafana/client.js';
import { buildInspectDataUrl, buildSoloPanelUrl } from '../grafana/urlBuilder.js';
import { resolveRenderWindow } from './renderDashboard.js';
import { materializeVariables } from './liveVariables.js';
import { redact } from '../security/redact.js';
import { resolveTargetDatasource, resolveToolClient } from './shared.js';

/**
 * The default capture size, shared by screenshot_panel's zod schema and the
 * Electron Activity window's own "Capture screenshot" button. 1600x900 is the
 * same 16:9 a typical Grafana panel is laid out for.
 */
export const DEFAULT_SCREENSHOT_WIDTH = 1600;
export const DEFAULT_SCREENSHOT_HEIGHT = 900;

/**
 * Everything a screenshot or CSV export needs to name and reach one specific
 * panel over one specific window, resolved once so screenshot_panel,
 * export_panel_csv, and the Electron Activity window's own buttons all reach a
 * panel the exact same way. This is the identical ~90-line prologue both MCP
 * tools used to carry inline; factored here so the UI path (which has no
 * calling agent, only an already-recorded activity entry's url) reuses it
 * rather than reimplementing URL/alert-rule/panel/window resolution.
 */
export interface PanelInvocation {
  client: GrafanaClient;
  connectionId: string;
  rawConnection: GrafanaConnection;
  dashboard: DashboardJson;
  panel: ResolvedPanel;
  dashboardUid: string;
  panelId: number;
  fromMs: number;
  toMs: number;
  overrides: Record<string, string[]>;
}

export interface PanelInvocationInput {
  url?: string;
  dashboardUid?: string;
  panelId?: number;
  panelTitle?: string;
  fromMs?: number;
  toMs?: number;
  variableOverrides?: Record<string, string[]>;
  connection?: string;
}

/**
 * Resolves the connection, dashboard/panel (from a dashboard/panel URL, an
 * alert-rule URL, or explicit dashboardUid+panelId), template-variable
 * overrides, and the query window — the shared front half of screenshot_panel
 * and export_panel_csv. `verb` ("capture"/"export") and `toolName` only shape
 * the one alert-rule-has-no-panel error message, which reads better naming the
 * specific operation that needed a panel.
 *
 * `onContext` reports the connection id and dashboard uid the moment each is
 * known — before any later step can throw — so a caller can still build a
 * clickable Grafana link for its error message when resolution fails partway
 * (a panel-not-found, an over-limit window, a dashboard fetch that errors).
 */
export interface ResolvePanelOptions {
  toolName: string;
  verb: string;
  windowLabel: string;
  onContext?: (ctx: { connectionId?: string; dashboardUid?: string }) => void;
}

export async function resolvePanelInvocation(
  registry: ConnectionRegistry,
  config: Config,
  input: PanelInvocationInput,
  { toolName, verb, windowLabel, onContext }: ResolvePanelOptions,
): Promise<PanelInvocation> {
  const { client, connectionId } = resolveToolClient(registry, { connection: input.connection, hintUrl: input.url });
  onContext?.({ connectionId });

  let dashboardUid = input.dashboardUid;
  let panelId = input.panelId;
  let urlVars: Record<string, string[]> = {};
  let urlFromRaw: string | undefined;
  let urlToRaw: string | undefined;

  if (input.url) {
    const parsed = parseGrafanaUrl(input.url);
    if (parsed.type === 'dashboard') {
      dashboardUid = parsed.uid;
      panelId = panelId ?? parsed.panelId;
      urlVars = parsed.vars;
      urlFromRaw = parsed.from;
      urlToRaw = parsed.to;
    } else {
      // Alert-rule URL: resolve its linked dashboard+panel the same way
      // get_alert_context does. That tool only warns when a rule has no
      // dashboard/panel link — but these operations categorically need one
      // specific panel, so the same condition is a hard error here.
      const rule = await client.getAlertRuleByUid(parsed.ruleUid);
      const dashUid = rule.annotations?.__dashboardUid__;
      const panelIdStr = rule.annotations?.__panelId__;
      if (!dashUid || !panelIdStr) {
        throw new Error(
          `Alert rule "${rule.title}" has no linked dashboard panel - ${toolName} needs one specific panel to ` +
            `${verb}. Use find_related_dashboards with the rule's labels to locate relevant dashboards.`,
        );
      }
      dashboardUid = dashUid;
      panelId = Number.parseInt(panelIdStr, 10);
    }
  }

  if (!dashboardUid) {
    throw new Error('Must provide either "url" (a dashboard or alert-rule link) or "dashboardUid".');
  }
  if (panelId === undefined) {
    throw new Error('Must provide "panelId" (or a url that already carries one, e.g. a "viewPanel"/"panelId" link).');
  }
  onContext?.({ connectionId, dashboardUid });

  const { dashboard } = await client.getDashboard(dashboardUid);
  const panel = findPanel(dashboard, panelId, input.panelTitle);
  if (!panel) {
    throw new Error(`Panel ${panelId} not found on dashboard ${dashboardUid}.`);
  }
  const overrides = mergeVariableOverrides(urlVars, input.variableOverrides);

  const { fromMs, toMs } = resolveRenderWindow({
    inputFromMs: input.fromMs,
    inputToMs: input.toMs,
    urlFromRaw,
    urlToRaw,
    dashboardTimeFrom: dashboard.time?.from,
    dashboardTimeTo: dashboard.time?.to,
    nowMs: Date.now(),
  });
  enforceWindowLimit({ label: windowLabel, fromMs, toMs }, config);

  const rawConnection = registry.list().find((c) => c.id === connectionId);
  if (!rawConnection) {
    throw new Error(`Unknown Grafana connection "${connectionId}".`);
  }

  return { client, connectionId, rawConnection, dashboard, panel, dashboardUid, panelId, fromMs, toMs, overrides };
}

export interface GeneratedPng {
  png: Buffer;
  /** Dimensions actually asked of the capture after clamping — read these, not the requested ones. */
  width: number;
  height: number;
  warnings: string[];
}

/**
 * Builds the d-solo panel URL and captures it as a PNG, clamping the requested
 * dimensions immediately before the capture (the only path into capturePanel,
 * whose BrowserWindow lives in this same process). Shared by screenshot_panel
 * and the Activity window's "Capture screenshot" button.
 */
export async function generatePanelPng(
  screenshotter: Screenshotter,
  config: Config,
  inv: PanelInvocation,
  requested: { width: number; height: number },
): Promise<GeneratedPng> {
  const soloUrl = buildSoloPanelUrl(inv.rawConnection.url, inv.dashboardUid, inv.panelId, {
    fromMs: inv.fromMs,
    toMs: inv.toMs,
    variables: inv.overrides,
  });
  const w = clampScreenshotDimension(requested.width, DEFAULT_SCREENSHOT_WIDTH);
  const h = clampScreenshotDimension(requested.height, DEFAULT_SCREENSHOT_HEIGHT);
  const warnings: string[] = [];
  if (w.clamped || h.clamped) {
    warnings.push(
      `Requested ${requested.width}x${requested.height} was clamped to ${w.value}x${h.value} ` +
        `(each dimension is bounded to ${MIN_SCREENSHOT_PX}-${MAX_SCREENSHOT_PX}px). The image is at the ` +
        'clamped size, so its aspect ratio may differ from what you asked for.',
    );
  }
  const png = await screenshotter.capturePanel({
    url: soloUrl,
    headers: { Authorization: buildAuthHeader(inv.rawConnection) },
    width: w.value,
    height: h.value,
    timeoutMs: config.screenshotTimeoutMs,
  });
  return { png, width: w.value, height: h.value, warnings };
}

/**
 * One CSV file's worth of exported data. `content` is already redacted (the
 * same as any tool output — a downloadable file is exactly the kind of thing
 * that ends up shared outside this conversation), so both the on-disk MCP
 * export and the Activity window's Downloads export write it verbatim. `suffix`
 * distinguishes the files of a multi-frame table export.
 */
export interface GeneratedCsvFile {
  content: string;
  refId?: string;
  rows: number;
  columns: string[];
  suffix?: string;
}

export interface GeneratedCsv {
  files: GeneratedCsvFile[];
  transformationsApplied: boolean;
  errors: Record<string, string>;
  unresolvedAllVariables: string[];
  captureNote?: string;
}

/**
 * Drives a real (hidden) browser to Grafana's own Inspect > Data view and
 * captures its "Download CSV" output with "Apply panel transformations"
 * checked — the only way to get a panel's actual on-screen data (joins,
 * reduces, renames, ...) that this server's own /api/ds/query-based export
 * can't see, since those only ever run in Grafana's frontend. Returns
 * undefined when there's nothing to gain this way: no screenshotter (the
 * standalone CLI has no browser), no transformations configured on this
 * panel (Screenshotter.exportPanelCsv's own contract), or the attempt itself
 * failed — in every case the caller falls back to the direct export below,
 * which is exactly as correct for an untransformed panel and always
 * available. `captureNote` is set only on a genuine failed attempt, since
 * that's the one case where the caller can't be sure it isn't missing a real
 * transformation.
 */
async function tryBrowserTransformedCsv(
  screenshotter: Screenshotter | undefined,
  inv: PanelInvocation,
  config: Config,
): Promise<{ csv: string } | { captureNote: string } | undefined> {
  if (!screenshotter) return undefined;
  const url = buildInspectDataUrl(inv.rawConnection.url, inv.dashboardUid, inv.panelId, {
    fromMs: inv.fromMs,
    toMs: inv.toMs,
    variables: inv.overrides,
  });
  try {
    const result = await screenshotter.exportPanelCsv({
      url,
      headers: { Authorization: buildAuthHeader(inv.rawConnection) },
      timeoutMs: config.screenshotTimeoutMs,
    });
    if (!result.csv) return undefined;
    return { csv: result.csv.toString('utf8') };
  } catch (err) {
    return {
      captureNote:
        'Could not verify whether this panel has Grafana-side transformations to reproduce via the real browser ' +
        `(falling back to raw per-query data): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Produces one panel's CSV data as in-memory, already-redacted files, without
 * touching the filesystem — callers decide where the bytes land (export_panel_csv
 * writes them under DATA_DIR; the Activity window writes them to Downloads).
 * Prefers Grafana's own transformed output via the browser when available,
 * falling back to this server's direct /api/ds/query export otherwise. See
 * export_panel_csv's tool description for the full contract this implements.
 */
export async function generatePanelCsv(
  screenshotter: Screenshotter | undefined,
  config: Config,
  inv: PanelInvocation,
): Promise<GeneratedCsv> {
  const browserResult = await tryBrowserTransformedCsv(screenshotter, inv, config);

  const files: GeneratedCsvFile[] = [];
  let errors: Record<string, string> = {};
  let unresolvedAllVariables: string[] = [];
  const transformationsApplied = browserResult !== undefined && 'csv' in browserResult;

  if (transformationsApplied && browserResult && 'csv' in browserResult) {
    // Grafana's own captured CSV. Written verbatim it would be — unlike the
    // fallback exports below — NOT neutralized against spreadsheet formula
    // injection, on what is the normal end-user path (Electron app running).
    // neutralizeCsvDocument parses it (full RFC 4180, since a quoted field can
    // span lines) and re-serializes it with every cell run through the same
    // neutralize-then-quote the direct exports use. The tradeoff #91 settled:
    // the file is now semantically identical to Grafana's Download CSV rather
    // than byte-for-byte identical (minimized quoting, CRLF line endings; a
    // leading BOM is preserved). redact() is applied here, on the serialized
    // text, exactly as it was on the raw bytes before.
    const { csv: neutralized, rows } = neutralizeCsvDocument(browserResult.csv);
    files.push({
      content: redact(neutralized, config.redactionPatterns),
      rows: Math.max(0, rows.length - 1),
      // From the parsed header row, neutralized to match the bytes actually
      // written — correct even when a field spanned lines, which the old
      // line-split count was not.
      columns: (rows[0] ?? []).map(neutralizeFormula),
    });
  } else if (inv.panel.mirrorsPanelIds) {
    // Grafana's built-in "-- Dashboard --" datasource: no backend to query at
    // all, so /api/ds/query always 404s here (the browser path above is the
    // only way to actually get this panel's on-screen value; if it didn't run
    // — no screenshotter — there's nothing left to fall back to).
    throw new Error(
      `Panel ${inv.panelId} ("${inv.panel.title ?? 'untitled'}") uses Grafana's built-in "-- Dashboard --" ` +
        `datasource — it re-displays panel ${inv.panel.mirrorsPanelIds.join(', ')}'s already-computed value ` +
        `client-side and has no data of its own to export. Export panel ${inv.panel.mirrorsPanelIds.join(', ')} instead.`,
    );
  } else {
    const window = { label: 'export', fromMs: inv.fromMs, toMs: inv.toMs };
    const variables = inv.dashboard.templating?.list ?? [];
    const materialized = await materializeVariables(inv.client, variables, inv.overrides, window);
    unresolvedAllVariables = materialized.unresolvedAllVariables;
    const resolvedOverrides = materialized.overrides;

    const targets: ResolvedTarget[] = await Promise.all(
      inv.panel.targets.map(async (t) => ({
        ...t,
        datasourceUid: await resolveTargetDatasource(inv.client, t.datasourceUid, variables, resolvedOverrides),
        raw: substituteTargetFields(t.raw, variables, resolvedOverrides, window, config.maxDataPoints),
      })),
    );

    const isTable = inv.panel.type === 'table' || inv.panel.type === 'table-old';

    if (isTable) {
      const maxDataPoints = clampMaxDataPoints(undefined, config);
      const request: DsQueryRequest = {
        from: String(inv.fromMs),
        to: String(inv.toMs),
        queries: targets.map((t) => buildDsQueryTarget(t, maxDataPoints)),
      };
      const response = await inv.client.queryDs(request);
      const frameEntries: Array<{ refId: string; frame: GrafanaFrame }> = [];
      for (const [refId, result] of Object.entries(response.results)) {
        if (result.error) {
          errors[refId] = result.error;
          continue;
        }
        for (const frame of result.frames ?? []) {
          frameEntries.push({ refId, frame });
        }
      }
      const countByRefId = new Map<string, number>();
      for (const { refId } of frameEntries) countByRefId.set(refId, (countByRefId.get(refId) ?? 0) + 1);
      const seenByRefId = new Map<string, number>();
      for (const { refId, frame } of frameEntries) {
        let suffix: string | undefined;
        if (frameEntries.length > 1) {
          const seen = seenByRefId.get(refId) ?? 0;
          seenByRefId.set(refId, seen + 1);
          suffix = (countByRefId.get(refId) ?? 0) > 1 ? `${refId}-${seen}` : refId;
        }
        files.push({
          content: redact(frameToCsv(frame), config.redactionPatterns),
          refId,
          rows: Math.max(0, ...frame.data.values.map((c) => c.length)),
          // Neutralized, to match the header row actually written to the file.
          // Reporting the raw name would silently break an agent matching a
          // reported column against the file's header.
          columns: frame.schema.fields.map((f) => neutralizeFormula(f.name)),
          suffix,
        });
      }
    } else {
      const result = await executeQueryWindow(inv.client, targets, window, config);
      errors = result.errors;
      files.push({
        content: redact(seriesToCsv(result.series), config.redactionPatterns),
        rows: new Set(result.series.flatMap((s) => s.points.map((p) => p.t))).size,
        columns: ['timestamp', ...buildSeriesColumnNames(result.series)].map(neutralizeFormula),
      });
    }
  }

  return {
    files,
    transformationsApplied,
    errors,
    unresolvedAllVariables,
    ...(browserResult && 'captureNote' in browserResult ? { captureNote: browserResult.captureNote } : {}),
  };
}

export const FORMULA_NEUTRALIZATION_NOTE =
  "This file is Grafana's own transformed on-screen data, re-parsed and re-serialized (RFC 4180) so " +
  'formula-leading cells could be neutralized against spreadsheet injection (a cell beginning with =, ' +
  '+, -, or @ is executed on open by Excel, LibreOffice, and Google Sheets). It is therefore ' +
  "semantically identical to Grafana's Download CSV but not byte-for-byte identical: field quoting is " +
  'minimized and line endings are normalized to CRLF (a leading BOM, if any, is preserved).';

export const MULTI_FILE_NOTE =
  "This panel's data came back as more than one frame (more than one query, or a datasource " +
  'splitting one query into several) - each is written to its own file rather than guessed-merged, ' +
  'since Grafana-side transformations used to combine them on screen are not applied here.';
