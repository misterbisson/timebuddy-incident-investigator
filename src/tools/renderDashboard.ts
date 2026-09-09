import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import type { QuerySeries } from '../query/executor.js';
import type { SeriesStats } from '../analysis/baseline.js';
import type { PanelTarget } from '../grafana/types.js';
import { parseGrafanaUrl } from '../alerts/urlParser.js';
import type { ConnectionPreferences } from '../grafana/preferences.js';
import { fetchConnectionPreferences } from '../grafana/preferences.js';
import {
  assertKnownTimeZone,
  DEFAULT_TIME_ZONE,
  DEFAULT_WEEK_START,
  describeGrafanaTimeExpr,
  normalizeTimeZone,
  normalizeWeekStart,
  parseGrafanaTimeExpr,
  type WeekStart,
} from '../query/dateMath.js';
import { flattenPanels, resolvePanelQueries } from '../dashboards/panelQueries.js';
import { substituteTargetFields, mergeVariableOverrides } from '../dashboards/variables.js';
import { executeQueryWindow } from '../query/executor.js';
import { computeStats } from '../analysis/baseline.js';
import { clampSeriesPoints, enforceWindowLimit } from '../security/limits.js';
import { dashboardUrlFor, recordActivity, resolveGotoUrl, resolveTargetDatasource, resolveToolClient, toolErrorResult } from './shared.js';
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
  /** The link's own `timezone` param — highest-precedence zone for period rounding. */
  urlTimezone?: string;
  dashboardTimeFrom?: string;
  dashboardTimeTo?: string;
  dashboardTimezone?: string;
  dashboardWeekStart?: string;
  nowMs: number;
  /**
   * Reads the connection's own Grafana timezone/week-start preferences. Called
   * at most once, and only when a selected expression actually needs a tier
   * the URL and dashboard didn't supply — a plain `now-1h` window never pays
   * for it. Omit to resolve against the documented defaults alone.
   */
  preferences?: () => Promise<ConnectionPreferences>;
}

/**
 * How a relative window was actually resolved, reported back on the result so
 * a caller isn't left re-deriving it. Present only when at least one bound
 * came from a relative expression; `weekStart` only when a `/w` round made it
 * matter, so its presence means "this actually moved the window."
 */
export interface RelativeTimeResolution {
  /** The raw expression each relative bound was resolved from (absent for a bound given as epoch ms). */
  from?: string;
  to?: string;
  /**
   * The zone the wall-clock boundaries were read in — present only when the
   * expression was zone-sensitive (any period rounding, or a shift by a day or
   * more), so its presence means the zone actually moved the window.
   */
  timeZone?: string;
  timeZoneSource?: 'url' | 'dashboard' | 'connection-preferences' | 'default';
  /** Present only when a "/w" round made the week-start matter. */
  weekStart?: WeekStart;
  weekStartSource?: 'dashboard' | 'connection-preferences' | 'default';
}

export interface ResolvedRenderWindow {
  fromMs: number;
  toMs: number;
  relativeTime?: RelativeTimeResolution;
}

/**
 * Picks the render window: an explicit fromMs/toMs always wins, then the
 * url's own from/to (Grafana relative or absolute), then the dashboard's own
 * saved default time range — so a bare dashboardUid with no other time
 * context still works. Each bound is resolved independently across those
 * tiers. Exported for direct testing of this fallback chain.
 *
 * Relative expressions go through query/dateMath.ts's full Grafana grammar,
 * including period rounding (`now/d`, `now/w-7d`). Two things that resolution
 * needs and this function is the place that assembles:
 *
 * - **`to` rounds up, `from` rounds down.** Grafana's own
 *   `rangeUtil.convertRawToRange` parses the two bounds with opposite
 *   `roundUp` flags, so `from=now/w-28d&to=now/w-7d` is a clean 28 days rather
 *   than the ~21 you'd get by snapping both to the same week edge.
 * - **The zone and week-start come from the connection, not from a guess.**
 *   Precedence mirrors Grafana's own frontend: the link's `timezone` param,
 *   then the dashboard's saved `timezone`/`weekStart`, then the connection's
 *   user/org preferences, then the documented defaults in dateMath.ts. The
 *   preferences read is lazy and skipped entirely for a zone-insensitive
 *   expression, and whichever tier answered is reported in the result — a
 *   wrong week-start is otherwise invisible.
 */
export async function resolveRenderWindow(input: ResolveRenderWindowInput): Promise<ResolvedRenderWindow> {
  // Select the winning expression per bound *before* parsing anything: a
  // dashboard's saved default range that this call will never use must not be
  // able to fail the call, and only a selected expression should be able to
  // trigger the preferences read.
  const fromExpr = input.inputFromMs !== undefined ? undefined : (input.urlFromRaw ?? input.dashboardTimeFrom);
  const toExpr = input.inputToMs !== undefined ? undefined : (input.urlToRaw ?? input.dashboardTimeTo);
  if ((input.inputFromMs === undefined && fromExpr === undefined) || (input.inputToMs === undefined && toExpr === undefined)) {
    throw new Error(
      'Could not determine a time window: pass fromMs/toMs explicitly, or a url whose "from"/"to" query ' +
        'params are set (this dashboard has no saved default time range either).',
    );
  }

  const shapes = [fromExpr, toExpr].filter((e): e is string => e !== undefined).map(describeGrafanaTimeExpr);
  const anyRelative = shapes.some((s) => s.relative);
  const zoneSensitive = shapes.some((s) => s.zoneSensitive);
  const needsWeekStart = shapes.some((s) => s.roundsWeek);

  let timeZone = normalizeTimeZone(input.urlTimezone);
  let timeZoneSource: NonNullable<RelativeTimeResolution['timeZoneSource']> = 'url';
  if (timeZone === undefined) {
    timeZone = normalizeTimeZone(input.dashboardTimezone);
    timeZoneSource = 'dashboard';
  }
  let weekStart = normalizeWeekStart(input.dashboardWeekStart);
  let weekStartSource: NonNullable<RelativeTimeResolution['weekStartSource']> = 'dashboard';

  const wantsPreferences = (zoneSensitive && timeZone === undefined) || (needsWeekStart && weekStart === undefined);
  if (wantsPreferences && input.preferences) {
    const prefs = await input.preferences();
    if (timeZone === undefined) {
      timeZone = normalizeTimeZone(prefs.timezone);
      timeZoneSource = 'connection-preferences';
    }
    if (weekStart === undefined) {
      weekStart = normalizeWeekStart(prefs.weekStart);
      weekStartSource = 'connection-preferences';
    }
  }
  if (timeZone === undefined) {
    timeZone = DEFAULT_TIME_ZONE;
    timeZoneSource = 'default';
  } else if (zoneSensitive) {
    // Only validated when it can actually move the window: a bogus zone saved
    // on a dashboard shouldn't fail a plain "now-1h" render that would ignore
    // it anyway.
    assertKnownTimeZone(timeZone, TIME_ZONE_SOURCE_LABEL[timeZoneSource]);
  }
  if (weekStart === undefined) {
    weekStart = DEFAULT_WEEK_START;
    weekStartSource = 'default';
  }

  const opts = { timeZone, weekStart };
  const fromMs = input.inputFromMs ?? parseGrafanaTimeExpr(fromExpr!, input.nowMs, opts);
  const toMs = input.inputToMs ?? parseGrafanaTimeExpr(toExpr!, input.nowMs, { ...opts, roundUp: true });

  if (!anyRelative) return { fromMs, toMs };
  return {
    fromMs,
    toMs,
    // Each field appears only when it actually bore on the result, so its
    // presence is the signal: a reported weekStart means a "/w" round used it,
    // and a reported timeZone means a boundary or calendar shift was read
    // against it. Reporting the defaults unconditionally would imply the
    // opposite for the common "now-1h" case, where neither matters.
    relativeTime: {
      ...(fromExpr !== undefined ? { from: fromExpr } : {}),
      ...(toExpr !== undefined ? { to: toExpr } : {}),
      ...(zoneSensitive ? { timeZone, timeZoneSource } : {}),
      ...(needsWeekStart ? { weekStart, weekStartSource } : {}),
    },
  };
}

const TIME_ZONE_SOURCE_LABEL: Record<NonNullable<RelativeTimeResolution['timeZoneSource']>, string> = {
  url: 'the link\'s "timezone" param',
  dashboard: "the dashboard's saved timezone",
  'connection-preferences': "the connection's Grafana preferences",
  default: 'the documented default',
};

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
        'dashboard, the same way get_alert_context does; errors if that rule has no dashboard link). A "/goto/<id>" ' +
        'share short-link is resolved to its canonical link first, transparently (a dead/pruned one errors ' +
        'distinctly from an unrecognized URL); a folder link errors - use list_folder_dashboards instead. Alternatively ' +
        'pass dashboardUid + connection directly, with fromMs/toMs (falls back to the dashboard\'s own saved default ' +
        'time range if omitted). ' +
        'A url\'s relative "from"/"to" support Grafana\'s full date-math grammar, including period rounding ("now/d", ' +
        '"now/w-7d", "now-1d/d"): rounding resolves against the connection\'s own timezone and week-start (the link\'s ' +
        '"timezone" param, else the dashboard\'s saved settings, else the Grafana user/org preferences, else UTC + ' +
        'Sunday), and the "to" bound rounds up while "from" rounds down - the same asymmetry Grafana\'s own range parsing ' +
        'uses, so from=now/w-28d&to=now/w-7d is a clean 28 days. Whenever a bound came from a relative expression, ' +
        '"window.relativeTime" reports the expressions and which timezone/week-start actually resolved them (weekStart ' +
        'only when a "/w" round made it matter) - read it rather than re-deriving the window yourself. ' +
        'Unlike execute_query_window, this uses exactly the one window given - no pre-window ' +
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
        variableOverrides: z.record(z.string(), z.array(z.string())).optional().describe('Variable name -> value(s); overrides the url\'s own var-* params per-name when both are given'),
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
          let urlTimezone: string | undefined;

          if (url) {
            const resolvedUrl = await resolveGotoUrl(registry, client, connectionId, url);
            const parsed = parseGrafanaUrl(resolvedUrl);
            if (parsed.type === 'dashboard') {
              dashboardUid = parsed.uid;
              urlVars = parsed.vars;
              urlFromRaw = parsed.from;
              urlToRaw = parsed.to;
              urlTimezone = parsed.timezone;
            } else if (parsed.type === 'folder') {
              throw new Error(
                `"${url}" is a folder link, not a dashboard - render_dashboard needs one specific dashboard. Use ` +
                  'list_folder_dashboards to see what\'s in this folder, then pass one of its dashboard links.',
              );
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

          const { fromMs, toMs, relativeTime } = await resolveRenderWindow({
            inputFromMs,
            inputToMs,
            urlFromRaw,
            urlToRaw,
            urlTimezone,
            dashboardTimeFrom: dashboard.time?.from,
            dashboardTimeTo: dashboard.time?.to,
            dashboardTimezone: dashboard.timezone,
            dashboardWeekStart: dashboard.weekStart,
            nowMs: Date.now(),
            preferences: () => fetchConnectionPreferences(client),
          });
          // Fail fast, before running a single query - same rationale as
          // execute_query_window's windowSizeWarning: a caller-visible error
          // up front beats attaching a warning to an already-oversized result.
          enforceWindowLimit({ label: 'render', fromMs, toMs }, config);

          const window = { fromMs, toMs };
          // Reported separately from `window` (which feeds variable
          // substitution and query execution as a plain QueryWindow) so the
          // resolution metadata rides on the result without leaking into
          // everything downstream that takes a window.
          const reportedWindow = { fromMs, toMs, ...(relativeTime ? { relativeTime } : {}) };
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
            window: reportedWindow,
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
