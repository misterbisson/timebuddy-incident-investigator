import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import type { QuerySeries } from '../query/executor.js';
import type { SeriesStats } from '../analysis/baseline.js';
import type { PanelTarget } from '../grafana/types.js';
import { parseGrafanaUrl, parseGrafanaTimeExpr } from '../alerts/urlParser.js';
import { flattenPanels, resolvePanelQueries } from '../dashboards/panelQueries.js';
import { substituteTargetFields, mergeVariableOverrides } from '../dashboards/variables.js';
import { executeQueryWindow } from '../query/executor.js';
import { computeStats } from '../analysis/baseline.js';
import { enforceWindowLimit } from '../security/limits.js';
import { dashboardUrlFor, resolveTargetDatasource, resolveToolClient, toolErrorText } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

interface RenderedTarget {
  refId: string;
  datasourceUid?: string;
  resolvedQuery: PanelTarget;
}

interface RenderedPanel {
  panelId: number;
  title?: string;
  type?: string;
  hasTargets: boolean;
  url?: string;
  /** Only set for a queryable panel past panelLimit — see panelsSkipped. */
  skipped?: boolean;
  targets?: RenderedTarget[];
  series?: Array<QuerySeries & { stats: SeriesStats }>;
  errors?: Record<string, string>;
  /** Set when resolving/executing this panel's own queries threw (e.g. an unresolvable datasource) — sibling panels still complete normally. */
  executionError?: string;
}

const DEFAULT_PANEL_LIMIT = 25;

export interface ResolveRenderWindowInput {
  inputFromMs?: number;
  inputToMs?: number;
  urlFromRaw?: string;
  urlToRaw?: string;
  dashboardTimeFrom?: string;
  dashboardTimeTo?: string;
  nowMs: number;
}

/**
 * Picks the render window: an explicit fromMs/toMs always wins, then the
 * url's own from/to (Grafana relative or absolute), then the dashboard's own
 * saved default time range — so a bare dashboardUid with no other time
 * context still works. Exported for direct testing of this fallback chain.
 */
export function resolveRenderWindow(input: ResolveRenderWindowInput): { fromMs: number; toMs: number } {
  const fromMs = input.inputFromMs
    ?? (input.urlFromRaw !== undefined ? parseGrafanaTimeExpr(input.urlFromRaw, input.nowMs) : undefined)
    ?? (input.dashboardTimeFrom !== undefined ? parseGrafanaTimeExpr(input.dashboardTimeFrom, input.nowMs) : undefined);
  const toMs = input.inputToMs
    ?? (input.urlToRaw !== undefined ? parseGrafanaTimeExpr(input.urlToRaw, input.nowMs) : undefined)
    ?? (input.dashboardTimeTo !== undefined ? parseGrafanaTimeExpr(input.dashboardTimeTo, input.nowMs) : undefined);
  if (fromMs === undefined || toMs === undefined) {
    throw new Error(
      'Could not determine a time window: pass fromMs/toMs explicitly, or a url whose "from"/"to" query ' +
        'params are set (this dashboard has no saved default time range either).',
    );
  }
  return { fromMs, toMs };
}

export function registerRenderDashboard(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'render_dashboard',
    {
      title: 'Render dashboard',
      description:
        'One-shot "what does this dashboard show right now": resolves and executes every queryable panel on a ' +
        'dashboard for a single time window, instead of chaining fetch_dashboard -> resolve_panel_queries -> ' +
        'execute_query_window per panel. Pass a dashboard/panel URL (its own "from"/"to" - relative like "now-1h" ' +
        'or absolute - and var-* overrides are used automatically), or an alert-rule URL (resolved to its linked ' +
        'dashboard, the same way get_alert_context does; errors if that rule has no dashboard link). Alternatively ' +
        'pass dashboardUid + connection directly, with fromMs/toMs (falls back to the dashboard\'s own saved default ' +
        'time range if omitted). Unlike execute_query_window, this uses exactly the one window given - no pre-window ' +
        'buffer, no baseline control windows - since the point here is "what\'s on screen", not incident analysis; ' +
        'use execute_query_window/validate_baseline for that. Every panel appears in "panels": queryable ones carry ' +
        'their resolved query, series (each with stats), and per-panel errors; row/text/non-queryable panels are ' +
        'metadata only (hasTargets: false, nothing executed); a queryable panel beyond panelLimit is marked ' +
        '"skipped: true" rather than silently dropped - check panelsSkipped/panelsTotal before assuming full coverage.',
      inputSchema: {
        url: z.string().optional().describe('A Grafana dashboard/panel or alert-rule URL'),
        dashboardUid: z.string().optional().describe('Dashboard UID, when not passing url (requires fromMs/toMs or falls back to the dashboard\'s saved default range, and a resolvable connection)'),
        fromMs: z.number().optional().describe('Window start, epoch ms - overrides the url\'s own "from" when both are given'),
        toMs: z.number().optional().describe('Window end, epoch ms - overrides the url\'s own "to" when both are given'),
        variableOverrides: z.record(z.array(z.string())).optional().describe('Variable name -> value(s); overrides the url\'s own var-* params per-name when both are given'),
        panelLimit: z.number().optional().default(DEFAULT_PANEL_LIMIT).describe('Max queryable panels to execute in one call; panels beyond this are listed with skipped: true, never silently dropped'),
        connection: z.string().optional().describe('Connection id to use, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Render dashboard' },
    },
    async ({ url, dashboardUid: inputDashboardUid, fromMs: inputFromMs, toMs: inputToMs, variableOverrides, panelLimit, connection }) => {
      let resolvedConnectionId: string | undefined;
      let resolvedDashboardUid: string | undefined;
      try {
        return await withAudit('render_dashboard', { url, dashboardUid: inputDashboardUid }, config, async () => {
          const { client, connectionId } = resolveToolClient(registry, { connection, hintUrl: url });
          resolvedConnectionId = connectionId;

          let dashboardUid = inputDashboardUid;
          let urlVars: Record<string, string[]> = {};
          let urlFromRaw: string | undefined;
          let urlToRaw: string | undefined;

          if (url) {
            const parsed = parseGrafanaUrl(url);
            if (parsed.type === 'dashboard') {
              dashboardUid = parsed.uid;
              urlVars = parsed.vars;
              urlFromRaw = parsed.from;
              urlToRaw = parsed.to;
            } else {
              // Alert-rule URL: resolve its linked dashboard the same way
              // get_alert_context does. That tool only warns when a rule has
              // no dashboard link, since a rule-only alert is still a valid
              // result there - but this tool categorically needs a dashboard
              // to render, so the same condition is a hard error here.
              const rule = await client.getAlertRuleByUid(parsed.ruleUid);
              const dashUid = rule.annotations?.__dashboardUid__;
              if (!dashUid) {
                throw new Error(
                  `Alert rule "${rule.title}" has no linked dashboard panel - render_dashboard needs a dashboard to ` +
                    'render. Use find_related_dashboards with the rule\'s labels to locate relevant dashboards.',
                );
              }
              dashboardUid = dashUid;
            }
          }

          if (!dashboardUid) {
            throw new Error('Must provide either "url" (a dashboard or alert-rule link) or "dashboardUid".');
          }
          resolvedDashboardUid = dashboardUid;

          const { dashboard } = await client.getDashboard(dashboardUid);
          const variables = dashboard.templating?.list ?? [];
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
          // Fail fast, before running a single query - same rationale as
          // execute_query_window's windowSizeWarning: a caller-visible error
          // up front beats attaching a warning to an already-oversized result.
          enforceWindowLimit({ label: 'render', fromMs, toMs }, config);

          const window = { fromMs, toMs };
          const allPanels = flattenPanels(dashboard.panels ?? []);
          const queryablePanels = resolvePanelQueries(dashboard);
          const queryableIds = new Set(queryablePanels.map((p) => p.panelId));
          const toExecute = queryablePanels.slice(0, panelLimit);
          const executeIds = new Set(toExecute.map((p) => p.panelId));

          const executed = await Promise.allSettled(
            toExecute.map(async (panel): Promise<RenderedPanel> => {
              const targets = await Promise.all(
                panel.targets.map(async (t) => ({
                  refId: t.refId,
                  datasourceUid: await resolveTargetDatasource(client, t.datasourceUid, variables, overrides),
                  raw: substituteTargetFields(t.raw, variables, overrides, window),
                })),
              );
              const result = await executeQueryWindow(client, targets, { label: 'render', fromMs, toMs }, config);
              return {
                panelId: panel.panelId,
                title: panel.title,
                type: panel.type,
                hasTargets: true,
                url: dashboardUrlFor(registry, connectionId, dashboardUid!, { panelId: panel.panelId, fromMs, toMs, variables: overrides }),
                targets: targets.map((t) => ({ refId: t.refId, datasourceUid: t.datasourceUid, resolvedQuery: t.raw })),
                series: result.series.map((s) => ({ ...s, stats: computeStats(s.points) })),
                errors: result.errors,
              };
            }),
          );

          const executedPanels: RenderedPanel[] = executed.map((r, i) => {
            const panel = toExecute[i]!;
            if (r.status === 'fulfilled') return r.value;
            return {
              panelId: panel.panelId,
              title: panel.title,
              type: panel.type,
              hasTargets: true,
              url: dashboardUrlFor(registry, connectionId, dashboardUid!, { panelId: panel.panelId, fromMs, toMs, variables: overrides }),
              executionError: r.reason instanceof Error ? r.reason.message : String(r.reason),
            };
          });

          const skippedPanels: RenderedPanel[] = queryablePanels
            .filter((p) => !executeIds.has(p.panelId))
            .map((p) => ({
              panelId: p.panelId,
              title: p.title,
              type: p.type,
              hasTargets: true,
              skipped: true,
              url: dashboardUrlFor(registry, connectionId, dashboardUid!, { panelId: p.panelId, fromMs, toMs, variables: overrides }),
            }));

          const nonQueryablePanels: RenderedPanel[] = allPanels
            .filter((p) => !queryableIds.has(p.id))
            .map((p) => ({
              panelId: p.id,
              title: p.title,
              type: p.type,
              hasTargets: false,
              url: dashboardUrlFor(registry, connectionId, dashboardUid!, { panelId: p.id }),
            }));

          const result = {
            url: dashboardUrlFor(registry, connectionId, dashboardUid, { fromMs, toMs, variables: overrides }),
            dashboardUid,
            title: dashboard.title,
            window,
            panelsTotal: queryablePanels.length,
            panelsExecuted: executedPanels.length,
            panelsSkipped: skippedPanels.length,
            panels: [...executedPanels, ...skippedPanels, ...nonQueryablePanels],
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        const errorUrl = resolvedConnectionId && resolvedDashboardUid ? dashboardUrlFor(registry, resolvedConnectionId, resolvedDashboardUid) : undefined;
        return { content: [{ type: 'text' as const, text: toolErrorText(err, errorUrl) }], isError: true };
      }
    },
  );
}
