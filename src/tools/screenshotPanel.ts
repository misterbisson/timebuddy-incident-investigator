import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import type { Screenshotter } from '../screenshot/types.js';
import { parseGrafanaUrl } from '../alerts/urlParser.js';
import { findPanel } from '../dashboards/panelQueries.js';
import { mergeVariableOverrides } from '../dashboards/variables.js';
import { buildAuthHeader } from '../grafana/client.js';
import { buildSoloPanelUrl } from '../grafana/urlBuilder.js';
import { clampScreenshotDimension, enforceWindowLimit, MAX_SCREENSHOT_PX, MIN_SCREENSHOT_PX } from '../security/limits.js';
import { dashboardUrlFor, recordActivity, resolveToolClient, toolErrorResult } from './shared.js';
import { resolveRenderWindow } from './renderDashboard.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';
import type { Config } from '../config.js';

const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 900;

/**
 * Persists the captured PNG to disk and returns its absolute path. The MCP
 * inline `image` content block lets the calling model see the panel, but the
 * host UI a person is actually watching (e.g. a terminal transcript) doesn't
 * necessarily render that inline image for them — confirmed in practice: a
 * real investigation used this tool several times and the person never saw
 * a single screenshot. A file on disk is unambiguous regardless of how (or
 * whether) the host renders inline image content: the calling agent can
 * point the person straight at it.
 */
async function saveScreenshot(png: Buffer, dashboardUid: string, panelId: number, config: Config): Promise<string> {
  const dir = join(config.dataDir, 'screenshots');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${dashboardUid}-panel${panelId}.png`);
  await writeFile(path, png);
  return path;
}

export function registerScreenshotPanel(server: McpServer, ctx: ToolContext & { screenshotter: Screenshotter }): void {
  const { registry, config, screenshotter, activityLog } = ctx;
  server.registerTool(
    'screenshot_panel',
    {
      title: 'Screenshot panel',
      description:
        'Captures a real screenshot of one dashboard panel exactly as Grafana renders it - client-side, via a ' +
        "hidden browser window, since most Grafana instances don't have the optional server-side Image Renderer " +
        "plugin installed - so you can actually see a chart's shape, not just its raw numbers. Returns the image " +
        'inline plus a clickable link to the same panel/window in Grafana. Pass a dashboard/panel URL (its own ' +
        '"from"/"to" and var-* overrides are used automatically) or an alert-rule URL (resolved to its linked ' +
        "dashboard+panel, the same way get_alert_context does; errors if that rule has no linked panel). " +
        'Alternatively pass dashboardUid + panelId + connection directly, with fromMs/toMs (falls back to the ' +
        "dashboard's own saved default time range if omitted). Best used selectively on the 1-2 panels that matter " +
        "for an investigation, not as a substitute for execute_query_window/render_dashboard's structured data. " +
        'The image is also written to disk and its path returned as "savedTo" - the inline image lets you (the ' +
        "model) see the panel, but the person you're talking to may not see inline image content the same way you " +
        'do, depending on how they\'re connected to you - always mention the savedTo path in your response so they ' +
        'can open the actual file themselves, not just your description of it. ' +
        `"width"/"height" are each clamped to ${MIN_SCREENSHOT_PX}-${MAX_SCREENSHOT_PX}px; if that changed what you asked ` +
        'for, the result carries a "warnings" array saying so and the returned "width"/"height" are the dimensions ' +
        'actually captured - read those rather than assuming your requested size was used. ' +
        'Note: unlike every other tool here, the image is NOT passed through the redaction layer - that only ' +
        'understands text - so anything visible on the panel itself (legend values, axis labels, annotation text) ' +
        'reaches the model as-is.',
      inputSchema: {
        url: z.string().optional().describe('A Grafana dashboard/panel or alert-rule URL'),
        dashboardUid: z.string().optional().describe('Dashboard UID, when not passing url'),
        panelId: z.number().optional().describe('Panel ID, when not passing url (or when the url doesn\'t already carry one)'),
        panelTitle: z.string().optional().describe('Disambiguates panelId when a dashboard has more than one panel sharing that id'),
        fromMs: z.number().optional().describe('Window start, epoch ms - overrides the url\'s own "from" when both are given'),
        toMs: z.number().optional().describe('Window end, epoch ms - overrides the url\'s own "to" when both are given'),
        variableOverrides: z.record(z.string(), z.array(z.string())).optional().describe('Variable name -> value(s); overrides the url\'s own var-* params per-name when both are given'),
        width: z.number().optional().default(DEFAULT_WIDTH).describe(`Screenshot width in pixels (clamped to ${MIN_SCREENSHOT_PX}-${MAX_SCREENSHOT_PX})`),
        height: z.number().optional().default(DEFAULT_HEIGHT).describe(`Screenshot height in pixels (clamped to ${MIN_SCREENSHOT_PX}-${MAX_SCREENSHOT_PX})`),
        connection: z.string().optional().describe('Connection id to use, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Screenshot panel' },
    },
    async ({ url, dashboardUid: inputDashboardUid, panelId: inputPanelId, panelTitle, fromMs: inputFromMs, toMs: inputToMs, variableOverrides, width: inputWidth, height: inputHeight, connection }) => {
      let resolvedConnectionId: string | undefined;
      let resolvedDashboardUid: string | undefined;
      try {
        return await withAudit('screenshot_panel', { url, dashboardUid: inputDashboardUid, panelId: inputPanelId }, config, async () => {
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
              // needs one specific panel to capture, so the same condition
              // is a hard error here.
              const rule = await client.getAlertRuleByUid(parsed.ruleUid);
              const dashUid = rule.annotations?.__dashboardUid__;
              const panelIdStr = rule.annotations?.__panelId__;
              if (!dashUid || !panelIdStr) {
                throw new Error(
                  `Alert rule "${rule.title}" has no linked dashboard panel - screenshot_panel needs one specific ` +
                    "panel to capture. Use find_related_dashboards with the rule's labels to locate relevant dashboards.",
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
          enforceWindowLimit({ label: 'screenshot', fromMs, toMs }, config);

          const rawConnection = registry.list().find((c) => c.id === connectionId);
          if (!rawConnection) {
            throw new Error(`Unknown Grafana connection "${connectionId}".`);
          }
          const soloUrl = buildSoloPanelUrl(rawConnection.url, dashboardUid, panelId, { fromMs, toMs, variables: overrides });
          // Clamped immediately before the capture, so nothing downstream can
          // see an unbounded dimension — this is the only path into
          // capturePanel, and the BrowserWindow it allocates lives in the same
          // process as the MCP server.
          const w = clampScreenshotDimension(inputWidth, DEFAULT_WIDTH);
          const h = clampScreenshotDimension(inputHeight, DEFAULT_HEIGHT);
          const warnings: string[] = [];
          if (w.clamped || h.clamped) {
            warnings.push(
              `Requested ${inputWidth}x${inputHeight} was clamped to ${w.value}x${h.value} ` +
                `(each dimension is bounded to ${MIN_SCREENSHOT_PX}-${MAX_SCREENSHOT_PX}px). The image below is at the ` +
                'clamped size, so its aspect ratio may differ from what you asked for.',
            );
          }
          const png = await screenshotter.capturePanel({
            url: soloUrl,
            headers: { Authorization: buildAuthHeader(rawConnection) },
            width: w.value,
            height: h.value,
            timeoutMs: config.screenshotTimeoutMs,
          });
          const savedTo = await saveScreenshot(png, dashboardUid, panelId, config);

          const resultUrl = dashboardUrlFor(registry, connectionId, dashboardUid, { panelId, fromMs, toMs, variables: overrides });
          recordActivity(registry, activityLog, {
            toolName: 'screenshot_panel',
            connectionId,
            dashboardUid,
            dashboardTitle: dashboard.title,
            panelId,
            panelTitle: panel.title,
            url: resultUrl,
            screenshotPath: savedTo,
          });
          const result = {
            url: resultUrl,
            dashboardUid,
            panelId,
            title: panel.title,
            type: panel.type,
            window: { fromMs, toMs },
            // The dimensions *asked of* the capture after clamping, not the
            // ones originally requested — and deliberately not described as
            // the dimensions captured: capturePanel returns only a Buffer, so
            // nothing here observes the window's real content size, which the
            // OS or useContentSize can still adjust. See issue #96.
            width: w.value,
            height: h.value,
            savedTo,
            ...(warnings.length > 0 ? { warnings } : {}),
          };
          return {
            content: [
              { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
              { type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) },
            ],
          };
        });
      } catch (err) {
        const errorUrl = resolvedConnectionId && resolvedDashboardUid ? dashboardUrlFor(registry, resolvedConnectionId, resolvedDashboardUid) : undefined;
        return toolErrorResult(err, config, errorUrl);
      }
    },
  );
}
