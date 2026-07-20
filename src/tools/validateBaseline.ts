import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { computeWindows, excludeOverlapping, type TimeWindow } from '../query/windows.js';
import { executeQueryWindow, type QuerySeries } from '../query/executor.js';
import { compareToBaseline } from '../analysis/baseline.js';
import { clampRunList } from '../security/limits.js';
import { dashboardUrlFor, epochMsSchema, recordActivity, resolvePanelForWindow, resolveToolClient, toolErrorText, windowSizeWarning } from './shared.js';
import { materializeVariables } from './liveVariables.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

function seriesKey(series: QuerySeries): string {
  const labelStr = Object.entries(series.labels).sort().map(([k, v]) => `${k}=${v}`).join(',');
  return `${series.refId}|${labelStr}`;
}

export function registerValidateBaseline(server: McpServer, { registry, config, activityLog }: ToolContext): void {
  server.registerTool(
    'validate_baseline',
    {
      title: 'Validate baseline',
      description:
        'Compares the incident window against prior-hour, same-hour-yesterday, and same-hour-last-week control ' +
        'windows (or custom offsets) for one panel, per series. Classifies each series as "statistically-unusual" ' +
        '(z-score beyond threshold vs. the pooled baseline) or "common-during-normal-operations", and flags when a ' +
        'similar-magnitude window recurs daily/weekly so recurring patterns aren\'t mistaken for a fresh anomaly. ' +
        'Always check each series\' "briefExcursions" too, even when classification says common — that ' +
        'classification is based on the whole window\'s *mean*, which can dilute a real, sharp, short-lived event ' +
        '(e.g. a health signal that was fully down for a few minutes inside a much longer analysis window) into ' +
        'looking routine. briefExcursions is a separate, point-level check against the same baseline and will still ' +
        'catch that. A control window whose offset is smaller than the incident\'s own duration (e.g. the default ' +
        'prior-hour control against an incident longer than ~1h) mostly overlaps the incident itself, so it\'s ' +
        'excluded from pooling automatically — check "warnings" for which ones, since a long incident can leave few ' +
        'or no default controls usable. If "endsAtMs" is omitted for a resolved (not still-firing) alert, this can ' +
        'silently build a many-day window, so this call errors instead of running in that case; pass "endsAtMs" ' +
        'explicitly.',
      inputSchema: {
        dashboardUid: z.string(),
        panelId: z.number(),
        panelTitle: z.string().optional().describe('Exact panel title — required only when panelId is ambiguous (multiple panels sharing one id, seen on some provisioned dashboards); the error message lists the candidates when this happens'),
        startsAtMs: epochMsSchema.describe('Incident start — epoch ms or an ISO 8601 date/time'),
        endsAtMs: epochMsSchema.optional().describe('Incident end — epoch ms or ISO 8601'),
        variableOverrides: z.record(z.array(z.string())).optional(),
        zThreshold: z.number().optional().default(3),
        controlOffsets: z
          .array(z.object({ label: z.string(), offsetMs: z.number() }))
          .optional()
          .describe('Override the default prior-hour/day/week baseline windows, e.g. a configurable quiet period'),
        connection: z.string().optional().describe('Connection id to use, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Validate baseline' },
    },
    async ({ dashboardUid, panelId, panelTitle, startsAtMs, endsAtMs, variableOverrides, zThreshold, controlOffsets, connection }) => {
      let resolvedConnectionId: string | undefined;
      try {
        return await withAudit('validate_baseline', { dashboardUid, panelId, startsAtMs, endsAtMs }, config, async () => {
          const { client, connectionId } = resolveToolClient(registry, { connection });
          resolvedConnectionId = connectionId;
          const windowSet = computeWindows({ startsAtMs, endsAtMs, controlOffsets });
          // Fail fast, before running a single Grafana query, rather than
          // executing an accidentally-huge window — see execute_query_window
          // for why attaching a warning to an already-oversized result isn't
          // good enough. Only fires when endsAtMs was omitted.
          const sizeWarning = windowSizeWarning(startsAtMs, endsAtMs, windowSet.incident.toMs);
          if (sizeWarning) {
            throw new Error(`${sizeWarning} No query was executed.`);
          }
          const overrides = variableOverrides ?? {};
          const allWindows: TimeWindow[] = [windowSet.incident, ...windowSet.controls];

          // Live-resolve any "$__all" query-type variable once against the
          // incident window, same as execute_query_window — otherwise a
          // baseline window could silently resolve to a different host list
          // than the incident and corrupt the apples-to-apples comparison.
          const { dashboard } = await client.getDashboard(dashboardUid);
          const variables = dashboard.templating?.list ?? [];
          const { overrides: resolvedOverrides, unresolvedAllVariables } = await materializeVariables(
            client,
            variables,
            overrides,
            windowSet.incident,
          );

          const executed = await Promise.all(
            allWindows.map(async (window) => {
              const { panel, targets } = await resolvePanelForWindow(client, dashboardUid, panelId, resolvedOverrides, window, config.maxDataPoints, panelTitle);
              return { window, panel, result: await executeQueryWindow(client, targets, window, config) };
            }),
          );
          const [incidentExec, ...allControlExecs] = executed;
          // A control offset smaller than the incident's own duration (e.g.
          // prior-hour, 1h, against a 5.5h incident) makes that "control"
          // mostly overlap the incident itself — pooling it in would silently
          // drag the baseline toward "looks normal" using the anomaly's own
          // data. Exclude it and say so, rather than let it corrupt the verdict.
          const { kept: controlExecs, excludedLabels: excludedOverlappingControls } = excludeOverlapping(
            windowSet.incident,
            allControlExecs,
          );

          const warnings: string[] = [];
          if (excludedOverlappingControls.length > 0) {
            warnings.push(
              `Excluded overlapping control window(s) from baseline pooling: ${excludedOverlappingControls.join(', ')} — ` +
                'their offset is smaller than the incident duration, so they mostly re-sample the incident itself rather than a clean baseline.',
            );
          }

          const seriesResults = incidentExec!.result.series.map((incidentSeries) => {
            const controlPoints = controlExecs.map((c) => ({
              label: c.window.label,
              points: c.result.series.find((s) => seriesKey(s) === seriesKey(incidentSeries))?.points ?? [],
            }));
            const comparison = compareToBaseline(incidentSeries.points, controlPoints, zThreshold);

            const recurringMatch = comparison.controlStats.find(
              (c) =>
                c.stats.count > 0 &&
                comparison.incidentStats.count > 0 &&
                Math.abs(c.stats.mean - comparison.incidentStats.mean) <= (c.stats.stddev || 1) * 1.5,
            );

            // Bounded for the same reason execute_query_window bounds `runs` —
            // crossing count, not point count, sets this list's length.
            const excursions = clampRunList(comparison.briefExcursions);

            return {
              refId: incidentSeries.refId,
              labels: incidentSeries.labels,
              ...comparison,
              briefExcursions: excursions.list,
              ...(excursions.truncated ? { briefExcursionsTotal: excursions.total } : {}),
              recurringPatternNote:
                comparison.classification === 'common-during-normal-operations' && recurringMatch
                  ? `Magnitude is similar to the "${recurringMatch.label}" window — looks like a recurring pattern, not a fresh anomaly.`
                  : undefined,
            };
          });

          const url = dashboardUrlFor(registry, connectionId, dashboardUid, {
            panelId,
            fromMs: windowSet.incident.fromMs,
            toMs: windowSet.incident.toMs,
          });
          recordActivity(registry, activityLog, {
            toolName: 'validate_baseline',
            connectionId,
            dashboardUid,
            dashboardTitle: dashboard.title,
            panelId,
            panelTitle: incidentExec!.panel.title,
            url,
          });
          const result = {
            url,
            window: windowSet.incident,
            controls: windowSet.controls,
            series: seriesResults,
            warnings,
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
