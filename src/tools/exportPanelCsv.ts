import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import type { Config } from '../config.js';
import { dashboardUrlFor, recordActivity, toolErrorResult } from './shared.js';
import {
  FORMULA_NEUTRALIZATION_NOTE,
  MULTI_FILE_NOTE,
  generatePanelCsv,
  resolvePanelInvocation,
} from './panelInvocation.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';
import { MAX_RENDER_WIDTH, MIN_RENDER_WIDTH } from '../security/limits.js';
import type { ExportResolution } from '../export/csv.js';

interface SavedCsvFile {
  path: string;
  refId?: string;
  rows: number;
  columns: string[];
  resolution?: ExportResolution;
}

/**
 * Writes one CSV body — already redacted and already neutralized against
 * spreadsheet formula injection by generatePanelCsv — to a file under DATA_DIR
 * and returns its path. The transformations the CSV needs (neutralize, then
 * redact) happen once, upstream in generatePanelCsv, so both this on-disk MCP
 * export and the Electron Activity window's Downloads export write the same
 * bytes; this only owns the filename and the write.
 */
async function saveCsv(csv: string, config: Config, dashboardUid: string, panelId: number, suffix?: string): Promise<string> {
  const dir = join(config.dataDir, 'csv');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${dashboardUid}-panel${panelId}${suffix ? `-${suffix}` : ''}.csv`);
  await writeFile(path, csv, 'utf8');
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
        'result. "transformationsApplied: true" means that succeeded - the file is Grafana\'s own on-screen data, ' +
        're-serialized (RFC 4180) so it can be neutralized against spreadsheet formula injection: semantically ' +
        'identical to Grafana\'s Download CSV, not byte-for-byte (see formulaNeutralizationNote). Otherwise ' +
        '("transformationsApplied: false") this panel has no transformations configured (nothing to ' +
        'gain from the browser this way) or no screenshotter is available (standalone CLI), and the file is this ' +
        "server's own direct export instead: table panels as-is (every column from the query's raw data frame, in " +
        'order); timeseries/graph panels pivoted wide (a UTC-timestamp column plus one column per series, named from ' +
        'its labels or refId, outer-joined on timestamp so series sampled at different rates don\'t drop each ' +
        'other\'s points). Check "transformCaptureNote" when present - it means the browser attempt was made but ' +
        'failed, so a real transformation may exist that this fallback data doesn\'t reflect. ' +
        'Every file this tool writes is neutralized against spreadsheet formula injection ("formulaNeutralized": true ' +
        'always): any cell beginning with =, +, -, or @ (or a whitespace character hiding one) is prefixed with an ' +
        'apostrophe, so a spreadsheet displays it instead of executing it. Numbers are exempt, so negative values are ' +
        'untouched - but a non-numeric cell like "-" or "-Infinity" does gain that apostrophe, so a few cells can ' +
        'differ from the same values in a query result; that is the export being neutralized, not wrong. Reported ' +
        '"columns" are neutralized too, so they match the file\'s header row. The Grafana-captured path ' +
        '(transformationsApplied: true) is neutralized by re-serializing Grafana\'s output rather than at cell level, ' +
        'so that file is semantically identical to Grafana\'s Download CSV but not byte-for-byte - see ' +
        'formulaNeutralizationNote. Pass a dashboard/panel ' +
        'URL (its own "from"/"to" and var-* overrides are used automatically) or an alert-rule URL (resolved to its ' +
        'linked dashboard+panel, the same way get_alert_context does), or dashboardUid + panelId + connection ' +
        'directly with fromMs/toMs (falls back to the dashboard\'s own saved default time range if omitted). Returns ' +
        '"files": each with its absolute path, row count, column names, and (when the file has a time axis) a ' +
        '"resolution" object - {points, effectiveBucketMs, spanMs, approximate} - so you can tell a coarse export ' +
        'from a fine one without deriving bucket width from the row spacing yourself. "approximate" is false when the ' +
        'bucket is measured from observed timestamps (this server\'s own direct export) and true when it is derived ' +
        'from the row count over the requested window (the browser-render path, whose time column is not reliably ' +
        're-parseable). For a panel WITH transformations, resolution is a function of the render viewport width, not ' +
        'the time range - pass "renderWidth" to render wider and pull finer buckets over a wide window in one call. ' +
        'Always mention the path so the person can open the actual file. In the direct-export fallback, if a table panel\'s data comes back as more than ' +
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
        variableOverrides: z.record(z.string(), z.array(z.string())).optional().describe('Variable name -> value(s); overrides the url\'s own var-* params per-name when both are given'),
        renderWidth: z.number().optional().describe(
          'Browser-render path only: the render viewport width in pixels (clamped to ' +
            `${MIN_RENDER_WIDTH}-${MAX_RENDER_WIDTH}). This governs the exported resolution for a panel WITH ` +
            'transformations - Grafana derives maxDataPoints from the rendered pixel width, so a wider render yields ' +
            'finer buckets over the same window (e.g. pass ~8100 to pull ~5-minute data over a 28-day window in one ' +
            'call). Defaults to 1400 when omitted. Has NO effect on the direct-export path (panels without ' +
            'transformations); the result "warnings" say so if you pass it and that path is taken.',
        ),
        connection: z.string().optional().describe('Connection id to use, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Export panel CSV' },
    },
    async ({ url, dashboardUid: inputDashboardUid, panelId: inputPanelId, panelTitle, fromMs: inputFromMs, toMs: inputToMs, variableOverrides, renderWidth, connection }) => {
      let resolvedConnectionId: string | undefined;
      let resolvedDashboardUid: string | undefined;
      try {
        return await withAudit('export_panel_csv', { url, dashboardUid: inputDashboardUid, panelId: inputPanelId }, config, async () => {
          const inv = await resolvePanelInvocation(
            registry,
            config,
            { url, dashboardUid: inputDashboardUid, panelId: inputPanelId, panelTitle, fromMs: inputFromMs, toMs: inputToMs, variableOverrides, connection },
            {
              toolName: 'export_panel_csv',
              verb: 'export',
              windowLabel: 'export',
              onContext: (c) => {
                if (c.connectionId) resolvedConnectionId = c.connectionId;
                if (c.dashboardUid) resolvedDashboardUid = c.dashboardUid;
              },
            },
          );

          const generated = await generatePanelCsv(screenshotter, config, inv, { renderWidth });

          const files: SavedCsvFile[] = [];
          for (const f of generated.files) {
            const path = await saveCsv(f.content, config, inv.dashboardUid, inv.panelId, f.suffix);
            files.push({
              path,
              ...(f.refId ? { refId: f.refId } : {}),
              rows: f.rows,
              columns: f.columns,
              ...(f.resolution ? { resolution: f.resolution } : {}),
            });
          }

          const resultUrl = dashboardUrlFor(registry, inv.connectionId, inv.dashboardUid, { panelId: inv.panelId, fromMs: inv.fromMs, toMs: inv.toMs, variables: inv.overrides });
          recordActivity(registry, activityLog, {
            toolName: 'export_panel_csv',
            connectionId: inv.connectionId,
            dashboardUid: inv.dashboardUid,
            dashboardTitle: inv.dashboard.title,
            panelId: inv.panelId,
            panelTitle: inv.panel.title,
            url: resultUrl,
          });
          const resultOut = {
            url: resultUrl,
            dashboardUid: inv.dashboardUid,
            panelId: inv.panelId,
            title: inv.panel.title,
            type: inv.panel.type,
            window: { fromMs: inv.fromMs, toMs: inv.toMs },
            transformationsApplied: generated.transformationsApplied,
            files,
            // Both paths are neutralized now: the direct exports at cell level,
            // and Grafana's captured CSV by parse + re-serialize (see
            // neutralizeCsvDocument). Kept as an always-true field rather than
            // dropped so an existing caller keying off it doesn't suddenly read
            // undefined — and paired below with the note on what re-serializing
            // the captured path costs.
            formulaNeutralized: true,
            ...(generated.transformationsApplied ? { formulaNeutralizationNote: FORMULA_NEUTRALIZATION_NOTE } : {}),
            ...(Object.keys(generated.errors).length > 0 ? { errors: generated.errors } : {}),
            ...(generated.unresolvedAllVariables.length > 0 ? { unresolvedAllVariables: generated.unresolvedAllVariables } : {}),
            ...(generated.captureNote ? { transformCaptureNote: generated.captureNote } : {}),
            ...(generated.renderWidth !== undefined ? { renderWidth: generated.renderWidth } : {}),
            ...(generated.warnings.length > 0 ? { warnings: generated.warnings } : {}),
            ...(files.length > 1 ? { note: MULTI_FILE_NOTE } : {}),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(resultOut, config.redactionPatterns)) }] };
        });
      } catch (err) {
        const errorUrl = resolvedConnectionId && resolvedDashboardUid ? dashboardUrlFor(registry, resolvedConnectionId, resolvedDashboardUid) : undefined;
        return toolErrorResult(err, config, errorUrl);
      }
    },
  );
}
