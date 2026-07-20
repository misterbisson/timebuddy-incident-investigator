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
import { clampSeriesPoints, enforceWindowLimit } from '../security/limits.js';
import { dashboardUrlFor, recordActivity, resolveTargetDatasource, resolveToolClient, toolErrorResult } from './shared.js';
import { materializeVariables } from './liveVariables.js';
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
  /** points is omitted (not just empty) when the caller passed includePoints: false. */
  series?: Array<Omit<QuerySeries, 'points'> & { points?: QuerySeries['points']; stats: SeriesStats }>;
  errors?: Record<string, string>;
  /** Set when resolving/executing this panel's own queries threw (e.g. an unresolvable datasource) — sibling panels still complete normally. */
  executionError?: string;
  /** Set instead of executing/erroring when this panel uses Grafana's built-in "-- Dashboard --" datasource — see panelQueries.ts's DASHBOARD_MIRROR_REF. Read the referenced panel(s) for the real data. */
  mirrorsPanelIds?: number[];
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

export function registerRenderDashboard(server: McpServer, { registry, config, activityLog }: ToolContext): void {
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
        '"skipped: true" rather than silently dropped - check panelsSkipped/panelsTotal before assuming full coverage. ' +
        'A panel using Grafana\'s built-in "-- Dashboard --" datasource (re-displays another panel\'s already-computed ' +
        'value client-side; no backend to query - always 404s if replayed) is never executed or reported as an error; ' +
        'it carries "mirrorsPanelIds" instead - read the referenced panel(s) in this same response for the real data. ' +
        'A "$__all" selection on a variable Grafana computes live (e.g. an InfluxQL "SHOW TAG VALUES" query variable) ' +
        'is best-effort live-resolved to its real value list; when that can\'t be done (unsupported datasource/query ' +
        'shape, or the live lookup itself failed) it falls back to matching everything, and the variable name is ' +
        'listed in "unresolvedAllVariables" - treat any panel depending on one of those as unscoped/unverified rather ' +
        'than trusting its series or applying a naming-convention guess to narrow it down. Pass includePoints: false ' +
        'to drop each series\' raw "points" array from every panel - "stats" is still computed and returned either ' +
        'way, so this only removes the raw arrays a wide-window/all-panel survey doesn\'t need.',
      inputSchema: {
        url: z.string().optional().describe('A Grafana dashboard/panel or alert-rule URL'),
        dashboardUid: z.string().optional().describe('Dashboard UID, when not passing url (requires fromMs/toMs or falls back to the dashboard\'s saved default range, and a resolvable connection)'),
        fromMs: z.number().optional().describe('Window start, epoch ms - overrides the url\'s own "from" when both are given'),
        toMs: z.number().optional().describe('Window end, epoch ms - overrides the url\'s own "to" when both are given'),
        variableOverrides: z.record(z.array(z.string())).optional().describe('Variable name -> value(s); overrides the url\'s own var-* params per-name when both are given'),
        panelLimit: z.number().optional().default(DEFAULT_PANEL_LIMIT).describe('Max queryable panels to execute in one call; panels beyond this are listed with skipped: true, never silently dropped'),
        includePoints: z.boolean().optional().default(true).describe('Set false to omit each panel series\' raw "points" array - stats are still computed and returned either way. Use this for a wide-window/all-panel survey, where only shape (min/max/mean) matters, to avoid an oversized response spilling to disk'),
        connection: z.string().optional().describe('Connection id to use, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Render dashboard' },
    },
    async ({ url, dashboardUid: inputDashboardUid, fromMs: inputFromMs, toMs: inputToMs, variableOverrides, panelLimit, includePoints, connection }) => {
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
          // Live-resolve any query-type variable stuck at the unconstrained '.*'
          // fallback (see liveVariables.ts) — resolvedOverrides feeds the actual
          // queries; the original overrides (not the potentially large resolved
          // value list) still builds the human-facing dashboard URLs below.
          const { overrides: resolvedOverrides, unresolvedAllVariables } = await materializeVariables(client, variables, overrides, window);
          const allPanels = flattenPanels(dashboard.panels ?? []);
          const queryablePanels = resolvePanelQueries(dashboard);
          // Mirror panels (Grafana's "-- Dashboard --" pseudo-datasource) have no
          // backend to query at all — executing them always 404s. Pull them out
          // before slicing to panelLimit so they never occupy an execution slot
          // or show up as a confusing per-panel error; report them separately.
          const executablePanels = queryablePanels.filter((p) => !p.mirrorsPanelIds);
          const mirrorPanels = queryablePanels.filter((p) => p.mirrorsPanelIds);
          const toExecute = executablePanels.slice(0, panelLimit);

          const executed = await Promise.allSettled(
            toExecute.map(async (panel): Promise<RenderedPanel> => {
              const targets = await Promise.all(
                panel.targets.map(async (t) => ({
                  refId: t.refId,
                  datasourceUid: await resolveTargetDatasource(client, t.datasourceUid, variables, resolvedOverrides),
                  raw: substituteTargetFields(t.raw, variables, resolvedOverrides, window, config.maxDataPoints),
                })),
              );
              const result = await executeQueryWindow(client, targets, { label: 'render', fromMs, toMs }, config);
              const url = dashboardUrlFor(registry, connectionId, dashboardUid!, { panelId: panel.panelId, fromMs, toMs, variables: overrides });
              recordActivity(registry, activityLog, {
                toolName: 'render_dashboard',
                connectionId,
                dashboardUid: dashboardUid!,
                dashboardTitle: dashboard.title,
                panelId: panel.panelId,
                panelTitle: panel.title,
                url,
              });
              return {
                panelId: panel.panelId,
                title: panel.title,
                type: panel.type,
                hasTargets: true,
                url,
                targets: targets.map((t) => ({ refId: t.refId, datasourceUid: t.datasourceUid, resolvedQuery: t.raw })),
                // stats from the full series, only the emitted points downsampled
                // — see the note in query/executor.ts on why the clamp lives here.
                series: clampSeriesPoints(result.series, config).map((s, i) => {
                  const { points, ...rest } = s;
                  return { ...rest, ...(includePoints ? { points } : {}), stats: computeStats(result.series[i]!.points) };
                }),
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

          // Index-based, not id-based: toExecute is literally the first
          // panelLimit entries of executablePanels, so "the rest" is exactly
          // this slice. A Set keyed by bare panelId would silently merge two
          // panels sharing an id (a real provisioning bug seen in practice —
          // see AmbiguousPanelError's doc comment), making the second one
          // vanish: not executed, not skipped, not anywhere in the output.
          const skippedPanels: RenderedPanel[] = executablePanels
            .slice(panelLimit)
            .map((p) => ({
              panelId: p.panelId,
              title: p.title,
              type: p.type,
              hasTargets: true,
              skipped: true,
              url: dashboardUrlFor(registry, connectionId, dashboardUid!, { panelId: p.panelId, fromMs, toMs, variables: overrides }),
            }));

          const mirrorRenderedPanels: RenderedPanel[] = mirrorPanels.map((p) => ({
            panelId: p.panelId,
            title: p.title,
            type: p.type,
            hasTargets: true,
            mirrorsPanelIds: p.mirrorsPanelIds,
            url: dashboardUrlFor(registry, connectionId, dashboardUid!, { panelId: p.panelId, fromMs, toMs, variables: overrides }),
          }));

          // Same reasoning as skippedPanels above: check each Panel's own
          // targets directly (matching resolvePanelQueries' own predicate)
          // rather than cross-referencing by id against queryablePanels,
          // which would misclassify a non-queryable panel that happens to
          // share an id with a queryable one.
          const nonQueryablePanels: RenderedPanel[] = allPanels
            .filter((p) => !p.targets?.length)
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
            panels: [...executedPanels, ...skippedPanels, ...mirrorRenderedPanels, ...nonQueryablePanels],
            ...(unresolvedAllVariables.length > 0 ? { unresolvedAllVariables } : {}),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        const errorUrl = resolvedConnectionId && resolvedDashboardUid ? dashboardUrlFor(registry, resolvedConnectionId, resolvedDashboardUid) : undefined;
        return toolErrorResult(err, config, errorUrl);
      }
    },
  );
}
