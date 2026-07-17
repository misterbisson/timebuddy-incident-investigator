import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { computeWindows, windowsOverlap } from '../query/windows.js';
import { executeQueryWindows, type WindowQueryResult } from '../query/executor.js';
import { findThresholdRuns } from '../analysis/runs.js';
import { computeStats } from '../analysis/baseline.js';
import { dashboardUrlFor, epochMsSchema, recordActivity, resolvePanelForWindow, resolveToolClient, toolErrorText, windowSizeWarning } from './shared.js';
import { materializeVariables } from './liveVariables.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

/**
 * Attaches per-series summary stats (min/max/mean/count/nonZeroCount) always,
 * and threshold-crossing runs when a threshold was requested. Answering "what's
 * the min/max here, was there any nonzero activity" is exactly the kind of
 * question that otherwise gets answered by dumping points to a file and
 * scripting it — computing it here means every execute_query_window call
 * already has the answer, with no extra call or param needed.
 *
 * includePoints:false drops the raw "points" array (stats/runs/pointsTotal are
 * still computed from it and returned) — for a wide survey where only the
 * shape of the anomaly matters, this is what keeps the response from
 * overflowing to disk in the first place, instead of overflowing and then
 * needing jq/bash to recover the same numbers stats() already computed.
 */
function annotateSeries(
  result: WindowQueryResult,
  threshold: number | undefined,
  direction: 'below' | 'above',
  includePoints: boolean,
) {
  return {
    ...result,
    series: result.series.map((s) => {
      const { points, ...rest } = s;
      return {
        ...rest,
        ...(includePoints ? { points } : {}),
        stats: computeStats(points),
        ...(threshold !== undefined ? { runs: findThresholdRuns(points, threshold, direction) } : {}),
      };
    }),
  };
}

export function registerExecuteQueryWindow(server: McpServer, { registry, config, activityLog }: ToolContext): void {
  server.registerTool(
    'execute_query_window',
    {
      title: 'Execute query window',
      description:
        'Replays one dashboard panel\'s queries (with template variables substituted) through Grafana\'s /api/ds/query ' +
        'for the incident window, a pre-window buffer (to see the anomaly\'s onset), and baseline control windows ' +
        '(prior hour, same-hour-yesterday, same-hour-last-week by default). Returns per-window time series so the ' +
        'caller can compare magnitudes directly, or feed them into validate_baseline / detect_correlated_anomalies. ' +
        'Every series always includes "stats" (min/max/mean/count/nonZeroCount) — check that before fetching raw ' +
        'points to answer things like "was there any traffic at all" or "what\'s the min/max here". ' +
        'Pass "threshold" (and optionally "thresholdDirection") to get each series\' precise dip/spike windows back ' +
        'directly — e.g. threshold: 1, thresholdDirection: "below" for an uptime-style metric (1.0 = fully up) finds ' +
        'exactly when each refId/series dropped below full health and for how long, including whether sibling ' +
        'series (e.g. other hosts/cells in the same panel) dipped too, and threshold: 0, thresholdDirection: "above" ' +
        'finds exactly when a volume/count metric had any activity. Always prefer stats/threshold over fetching the ' +
        'raw points and scripting the same analysis yourself. If "endsAtMs" is omitted and the alert is resolved ' +
        '(not still firing), it defaults to now — for an old/resolved alert this can silently build a many-day ' +
        'window, so this call errors instead of running in that case; pass "endsAtMs" explicitly (from the alert\'s ' +
        'own resolved end, or the dashboard link\'s "to" param). A "$__all" selection on a variable Grafana computes ' +
        'live (e.g. an InfluxQL "SHOW TAG VALUES" query variable) is best-effort live-resolved to its real value ' +
        'list, once, using the incident window; when that can\'t be done it falls back to matching everything, and ' +
        'the variable name is listed in the top-level "unresolvedAllVariables" (omitted when empty) — treat the ' +
        'result as unscoped/unverified rather than trusting it or narrowing it down with a naming-convention guess. ' +
        'Pass includePoints: false to drop each series\' raw "points" array from the response - "stats" and "runs" ' +
        '(when threshold is set) are still computed from the full data either way, so this only removes the raw ' +
        'array a wide/long-window call doesn\'t need, keeping the response from spilling to disk.',
      inputSchema: {
        dashboardUid: z.string(),
        panelId: z.number(),
        panelTitle: z.string().optional().describe('Exact panel title — required only when panelId is ambiguous (multiple panels sharing one id, seen on some provisioned dashboards); the error message lists the candidates when this happens'),
        startsAtMs: epochMsSchema.describe('Incident start — epoch ms or an ISO 8601 date/time (e.g. the alert\'s startsAt, or "2026-06-08T00:00:00Z")'),
        endsAtMs: epochMsSchema.optional().describe('Incident end — epoch ms or ISO 8601; defaults to now for still-firing alerts'),
        preWindowMs: z.number().optional().describe('Buffer before the incident start, ms; defaults to max(30min, incident duration)'),
        variableOverrides: z.record(z.array(z.string())).optional(),
        includeControls: z.boolean().optional().default(true).describe('Include prior-hour/day/week baseline windows'),
        threshold: z.number().optional().describe('When set, each returned series gets a "runs" array of contiguous points crossing this value (start/end/duration/min/max) - e.g. 1 for an uptime metric'),
        thresholdDirection: z.enum(['below', 'above']).optional().default('below').describe('Whether "threshold" means find runs below or above that value'),
        includePoints: z.boolean().optional().default(true).describe('Set false to omit each series\' raw "points" array - stats/runs are still computed and returned either way'),
        connection: z.string().optional().describe('Connection id to use, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Execute query window' },
    },
    async ({ dashboardUid, panelId, panelTitle, startsAtMs, endsAtMs, preWindowMs, variableOverrides, includeControls, threshold, thresholdDirection, includePoints, connection }) => {
      let resolvedConnectionId: string | undefined;
      try {
        return await withAudit('execute_query_window', { dashboardUid, panelId, startsAtMs, endsAtMs }, config, async () => {
          const { client, connectionId } = resolveToolClient(registry, { connection });
          resolvedConnectionId = connectionId;
          const windowSet = computeWindows({
            startsAtMs,
            endsAtMs,
            preWindowMs,
            controlOffsets: includeControls ? undefined : [],
          });
          // Fail fast, before running a single Grafana query, rather than
          // executing an accidentally-huge window and attaching a warning to
          // a result that's already oversized — a truncated-to-file tool
          // result buries that warning behind exactly the jq/bash detour this
          // tool exists to avoid. Only fires when endsAtMs was omitted; an
          // explicit endsAtMs (even a deliberately huge one, or "now" for a
          // genuinely still-firing multi-day incident) is always honored.
          const sizeWarning = windowSizeWarning(startsAtMs, endsAtMs, windowSet.incident.toMs);
          if (sizeWarning) {
            throw new Error(`${sizeWarning} No query was executed.`);
          }
          const allWindows = [windowSet.incident, windowSet.preWindow, ...windowSet.controls];
          const overrides = variableOverrides ?? {};

          // Live-resolve any "$__all" query-type variable once, using the incident
          // window — not per-window like the substitution below, since letting a
          // baseline window (e.g. same-hour-last-week) live-resolve to a *different*
          // host list than the incident window would break the apples-to-apples
          // comparison these baselines exist for. Costs one extra dashboard fetch.
          const { dashboard } = await client.getDashboard(dashboardUid);
          const variables = dashboard.templating?.list ?? [];
          const { overrides: resolvedOverrides, unresolvedAllVariables } = await materializeVariables(
            client,
            variables,
            overrides,
            windowSet.incident,
          );

          // Variable values don't depend on the window, but $__interval/$timeFilter
          // do — resolve targets once per window rather than once overall.
          let resolvedPanelTitle: string | undefined;
          const resultsPerWindow = await Promise.all(
            allWindows.map(async (window) => {
              const { panel, targets } = await resolvePanelForWindow(client, dashboardUid, panelId, resolvedOverrides, window, config.maxDataPoints, panelTitle);
              resolvedPanelTitle ??= panel.title;
              const [result] = await executeQueryWindows(client, targets, [window], config);
              return annotateSeries(result!, threshold, thresholdDirection, includePoints);
            }),
          );

          const [incident, preWindow, ...rawControls] = resultsPerWindow;
          // A control's fixed offset (e.g. prior-hour's 1h) can be smaller
          // than the incident's own duration, in which case it mostly
          // overlaps the incident rather than acting as a clean baseline —
          // flagged here (not excluded, unlike validate_baseline's pooling)
          // since this tool just returns data for the caller to read.
          const controls = rawControls.map((c) => ({ ...c, overlapsIncident: windowsOverlap(windowSet.incident, c.window) }));
          const url = dashboardUrlFor(registry, connectionId, dashboardUid, {
            panelId,
            fromMs: windowSet.incident.fromMs,
            toMs: windowSet.incident.toMs,
          });
          recordActivity(registry, activityLog, {
            toolName: 'execute_query_window',
            connectionId,
            dashboardUid,
            dashboardTitle: dashboard.title,
            panelId,
            panelTitle: resolvedPanelTitle,
            url,
          });
          const result = {
            url,
            incident,
            preWindow,
            controls,
            ...(unresolvedAllVariables.length > 0 ? { unresolvedAllVariables } : {}),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        const url = resolvedConnectionId ? dashboardUrlFor(registry, resolvedConnectionId, dashboardUid, { panelId }) : undefined;
        return { content: [{ type: 'text' as const, text: toolErrorText(err, url) }], isError: true };
      }
    },
  );
}
