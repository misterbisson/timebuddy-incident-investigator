import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import type { Config, GrafanaConnection } from '../config.js';
import type { GrafanaFrame, DsQueryRequest } from '../grafana/types.js';
import type { ResolvedTarget } from '../dashboards/panelQueries.js';
import type { Screenshotter } from '../screenshot/types.js';
import { parseGrafanaUrl } from '../alerts/urlParser.js';
import { findPanel } from '../dashboards/panelQueries.js';
import { mergeVariableOverrides, substituteTargetFields } from '../dashboards/variables.js';
import { buildDsQueryTarget, executeQueryWindow } from '../query/executor.js';
import { enforceWindowLimit, clampMaxDataPoints } from '../security/limits.js';
import { buildSeriesColumnNames, frameToCsv, parseCsvLine, seriesToCsv } from '../export/csv.js';
import { buildAuthHeader } from '../grafana/client.js';
import { buildInspectDataUrl } from '../grafana/urlBuilder.js';
import { dashboardUrlFor, recordActivity, resolveTargetDatasource, resolveToolClient, toolErrorText } from './shared.js';
import { resolveRenderWindow } from './renderDashboard.js';
import { materializeVariables } from './liveVariables.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

interface SavedCsvFile {
  path: string;
  refId?: string;
  rows: number;
  columns: string[];
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
  connection: GrafanaConnection,
  dashboardUid: string,
  panelId: number,
  fromMs: number,
  toMs: number,
  overrides: Record<string, string[]>,
  config: Config,
): Promise<{ csv: string } | { captureNote: string } | undefined> {
  if (!screenshotter) return undefined;
  const url = buildInspectDataUrl(connection.url, dashboardUid, panelId, { fromMs, toMs, variables: overrides });
  try {
    const result = await screenshotter.exportPanelCsv({
      url,
      headers: { Authorization: buildAuthHeader(connection) },
      timeoutMs: config.screenshotTimeoutMs,
    });
    if (!result.csv) return undefined;
    return { csv: result.csv.toString('utf8') };
  } catch (err) {
    return {
      captureNote:
        "Could not verify whether this panel has Grafana-side transformations to reproduce via the real browser " +
        `(falling back to raw per-query data): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The CSV text itself is redacted the same as any other tool output, even
 * though (unlike the JSON result) it never reaches the model directly - a
 * "downloadable for reporting/presentations" file is exactly the kind of
 * thing that ends up shared outside this conversation, so a customer-
 * identifier pattern configured in redactionPatterns should still apply to it.
 */
async function saveCsv(csv: string, config: Config, dashboardUid: string, panelId: number, suffix?: string): Promise<string> {
  const dir = join(config.dataDir, 'csv');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${dashboardUid}-panel${panelId}${suffix ? `-${suffix}` : ''}.csv`);
  await writeFile(path, redact(csv, config.redactionPatterns), 'utf8');
  return path;
}

export function registerExportPanelCsv(server: McpServer, { registry, config, screenshotter, activityLog }: ToolContext): void {
  server.registerTool(
    'export_panel_csv',
    {
      title: 'Export panel CSV',
      description:
        'Writes one dashboard panel\'s data to a CSV file on disk, for archiving/reporting/presentations or further ' +
        'analysis in another tool. When the Electron app is running this server (its "screenshotter" capability), ' +
        'this first tries to capture the panel\'s real on-screen data - driving a hidden browser to Grafana\'s own ' +
        'Inspect > Data view with "Apply panel transformations" checked, so a panel with a join/reduce/rename/etc. ' +
        'configured comes back exactly as a person looking at the dashboard would see it, not just the raw per-query ' +
        'result. "transformationsApplied: true" means that succeeded - the file is Grafana\'s own output, byte for ' +
        'byte. Otherwise ("transformationsApplied: false") this panel has no transformations configured (nothing to ' +
        'gain from the browser this way) or no screenshotter is available (standalone CLI), and the file is this ' +
        "server's own direct export instead: table panels as-is (every column from the query's raw data frame, in " +
        'order); timeseries/graph panels pivoted wide (a UTC-timestamp column plus one column per series, named from ' +
        'its labels or refId, outer-joined on timestamp so series sampled at different rates don\'t drop each ' +
        'other\'s points). Check "transformCaptureNote" when present - it means the browser attempt was made but ' +
        'failed, so a real transformation may exist that this fallback data doesn\'t reflect. Pass a dashboard/panel ' +
        'URL (its own "from"/"to" and var-* overrides are used automatically) or an alert-rule URL (resolved to its ' +
        'linked dashboard+panel, the same way get_alert_context does), or dashboardUid + panelId + connection ' +
        'directly with fromMs/toMs (falls back to the dashboard\'s own saved default time range if omitted). Returns ' +
        '"files": each with its absolute path, row count, and column names - always mention the path so the person ' +
        'can open the actual file. In the direct-export fallback, if a table panel\'s data comes back as more than ' +
        'one frame (more than one query, or a datasource splitting one query into several), each frame is written to ' +
        'its own file rather than guessed-merged - see the "note" field when that happens. A "$__all" selection on a ' +
        'variable Grafana computes live (e.g. an InfluxQL "SHOW TAG VALUES" query variable) is best-effort ' +
        'live-resolved to its real value list in the direct-export fallback; when that can\'t be done it falls back ' +
        'to matching everything, and the variable name is listed in "unresolvedAllVariables" (omitted when empty, ' +
        'and never present when transformationsApplied is true - the browser resolves its own variables) - treat the ' +
        'export as unscoped/unverified rather than trusting it in that case.',
      inputSchema: {
        url: z.string().optional().describe('A Grafana dashboard/panel or alert-rule URL'),
        dashboardUid: z.string().optional().describe('Dashboard UID, when not passing url'),
        panelId: z.number().optional().describe('Panel ID, when not passing url (or when the url doesn\'t already carry one)'),
        panelTitle: z.string().optional().describe('Disambiguates panelId when a dashboard has more than one panel sharing that id'),
        fromMs: z.number().optional().describe('Window start, epoch ms - overrides the url\'s own "from" when both are given'),
        toMs: z.number().optional().describe('Window end, epoch ms - overrides the url\'s own "to" when both are given'),
        variableOverrides: z.record(z.array(z.string())).optional().describe('Variable name -> value(s); overrides the url\'s own var-* params per-name when both are given'),
        connection: z.string().optional().describe('Connection id to use, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Export panel CSV' },
    },
    async ({ url, dashboardUid: inputDashboardUid, panelId: inputPanelId, panelTitle, fromMs: inputFromMs, toMs: inputToMs, variableOverrides, connection }) => {
      let resolvedConnectionId: string | undefined;
      let resolvedDashboardUid: string | undefined;
      try {
        return await withAudit('export_panel_csv', { url, dashboardUid: inputDashboardUid, panelId: inputPanelId }, config, async () => {
          const { client, connectionId } = resolveToolClient(registry, { connection, hintUrl: url });
          resolvedConnectionId = connectionId;

          let dashboardUid = inputDashboardUid;
          let panelId = inputPanelId;
          let urlVars: Record<string, string[]> = {};
          let urlFromRaw: string | undefined;
          let urlToRaw: string | undefined;

          if (url) {
            const parsed = parseGrafanaUrl(url);
            if (parsed.type === 'dashboard') {
              dashboardUid = parsed.uid;
              panelId = panelId ?? parsed.panelId;
              urlVars = parsed.vars;
              urlFromRaw = parsed.from;
              urlToRaw = parsed.to;
            } else {
              // Alert-rule URL: resolve its linked dashboard+panel the same
              // way get_alert_context does. That tool only warns when a rule
              // has no dashboard/panel link - but this tool categorically
              // needs one specific panel to export, so the same condition is
              // a hard error here.
              const rule = await client.getAlertRuleByUid(parsed.ruleUid);
              const dashUid = rule.annotations?.__dashboardUid__;
              const panelIdStr = rule.annotations?.__panelId__;
              if (!dashUid || !panelIdStr) {
                throw new Error(
                  `Alert rule "${rule.title}" has no linked dashboard panel - export_panel_csv needs one specific ` +
                    "panel to export. Use find_related_dashboards with the rule's labels to locate relevant dashboards.",
                );
              }
              dashboardUid = dashUid;
              panelId = Number.parseInt(panelIdStr, 10);
            }
          }

          if (!dashboardUid) {
            throw new Error('Must provide either "url" (a dashboard or alert-rule link) or "dashboardUid".');
          }
          resolvedDashboardUid = dashboardUid;
          if (panelId === undefined) {
            throw new Error('Must provide "panelId" (or a url that already carries one, e.g. a "viewPanel"/"panelId" link).');
          }

          const { dashboard } = await client.getDashboard(dashboardUid);
          const panel = findPanel(dashboard, panelId, panelTitle);
          if (!panel) {
            throw new Error(`Panel ${panelId} not found on dashboard ${dashboardUid}.`);
          }
          const overrides = mergeVariableOverrides(urlVars, variableOverrides);

          const { fromMs, toMs } = resolveRenderWindow({
            inputFromMs,
            inputToMs,
            urlFromRaw,
            urlToRaw,
            dashboardTimeFrom: dashboard.time?.from,
            dashboardTimeTo: dashboard.time?.to,
            nowMs: Date.now(),
          });
          const window = { label: 'export', fromMs, toMs };
          enforceWindowLimit(window, config);

          const rawConnection = registry.list().find((c) => c.id === connectionId);
          if (!rawConnection) {
            throw new Error(`Unknown Grafana connection "${connectionId}".`);
          }
          const browserResult = await tryBrowserTransformedCsv(
            screenshotter,
            rawConnection,
            dashboardUid,
            panelId,
            fromMs,
            toMs,
            overrides,
            config,
          );

          const files: SavedCsvFile[] = [];
          let errors: Record<string, string> = {};
          let unresolvedAllVariables: string[] = [];
          const transformationsApplied = browserResult !== undefined && 'csv' in browserResult;

          if (transformationsApplied && browserResult && 'csv' in browserResult) {
            const path = await saveCsv(browserResult.csv, config, dashboardUid, panelId);
            const lines = browserResult.csv.split(/\r\n|\n/).filter((l) => l.length > 0);
            files.push({ path, rows: Math.max(0, lines.length - 1), columns: lines[0] ? parseCsvLine(lines[0]) : [] });
          } else if (panel.mirrorsPanelIds) {
            // Grafana's built-in "-- Dashboard --" datasource: no backend to
            // query at all, so /api/ds/query always 404s here (the browser
            // path above is the only way to actually get this panel's
            // on-screen value; if it didn't run — no screenshotter — there's
            // nothing left to fall back to).
            throw new Error(
              `Panel ${panelId} ("${panel.title ?? 'untitled'}") uses Grafana's built-in "-- Dashboard --" datasource ` +
                `— it re-displays panel ${panel.mirrorsPanelIds.join(', ')}'s already-computed value client-side and ` +
                `has no data of its own to export. Export panel ${panel.mirrorsPanelIds.join(', ')} instead.`,
            );
          } else {
            const variables = dashboard.templating?.list ?? [];
            const materialized = await materializeVariables(client, variables, overrides, window);
            unresolvedAllVariables = materialized.unresolvedAllVariables;
            const resolvedOverrides = materialized.overrides;

            const targets: ResolvedTarget[] = await Promise.all(
              panel.targets.map(async (t) => ({
                ...t,
                datasourceUid: await resolveTargetDatasource(client, t.datasourceUid, variables, resolvedOverrides),
                raw: substituteTargetFields(t.raw, variables, resolvedOverrides, window),
              })),
            );

            const isTable = panel.type === 'table' || panel.type === 'table-old';

            if (isTable) {
              const maxDataPoints = clampMaxDataPoints(undefined, config);
              const request: DsQueryRequest = {
                from: String(fromMs),
                to: String(toMs),
                queries: targets.map((t) => buildDsQueryTarget(t, maxDataPoints)),
              };
              const response = await client.queryDs(request);
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
                const path = await saveCsv(frameToCsv(frame), config, dashboardUid, panelId, suffix);
                files.push({
                  path,
                  refId,
                  rows: Math.max(0, ...frame.data.values.map((c) => c.length)),
                  columns: frame.schema.fields.map((f) => f.name),
                });
              }
            } else {
              const result = await executeQueryWindow(client, targets, window, config);
              errors = result.errors;
              const path = await saveCsv(seriesToCsv(result.series), config, dashboardUid, panelId);
              files.push({
                path,
                rows: new Set(result.series.flatMap((s) => s.points.map((p) => p.t))).size,
                columns: ['timestamp', ...buildSeriesColumnNames(result.series)],
              });
            }
          }

          const resultUrl = dashboardUrlFor(registry, connectionId, dashboardUid, { panelId, fromMs, toMs, variables: overrides });
          recordActivity(registry, activityLog, {
            toolName: 'export_panel_csv',
            connectionId,
            dashboardUid,
            dashboardTitle: dashboard.title,
            panelId,
            panelTitle: panel.title,
            url: resultUrl,
          });
          const resultOut = {
            url: resultUrl,
            dashboardUid,
            panelId,
            title: panel.title,
            type: panel.type,
            window: { fromMs, toMs },
            transformationsApplied,
            files,
            ...(Object.keys(errors).length > 0 ? { errors } : {}),
            ...(unresolvedAllVariables.length > 0 ? { unresolvedAllVariables } : {}),
            ...(browserResult && 'captureNote' in browserResult ? { transformCaptureNote: browserResult.captureNote } : {}),
            ...(files.length > 1
              ? {
                  note: 'This panel\'s data came back as more than one frame (more than one query, or a datasource ' +
                    'splitting one query into several) - each is written to its own file rather than guessed-merged, ' +
                    'since Grafana-side transformations used to combine them on screen are not applied here.',
                }
              : {}),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(resultOut, config.redactionPatterns)) }] };
        });
      } catch (err) {
        const errorUrl = resolvedConnectionId && resolvedDashboardUid ? dashboardUrlFor(registry, resolvedConnectionId, resolvedDashboardUid) : undefined;
        return { content: [{ type: 'text' as const, text: toolErrorText(err, errorUrl) }], isError: true };
      }
    },
  );
}
