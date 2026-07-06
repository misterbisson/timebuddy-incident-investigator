import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { computeWindows } from '../query/windows.js';
import { executeQueryWindow, type QuerySeries } from '../query/executor.js';
import { computeStats, detectOnset } from '../analysis/baseline.js';
import { rankCorrelatedAnomalies, type CorrelationCandidateInput } from '../analysis/correlation.js';
import { getOrBuildIndex } from '../index-builder/metricIndex.js';
import { extractQueryInfo } from '../index-builder/extract.js';
import { resolvePanelForWindow } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

function seriesKey(series: QuerySeries): string {
  const labelStr = Object.entries(series.labels).sort().map(([k, v]) => `${k}=${v}`).join(',');
  return `${series.refId}|${labelStr}`;
}

export function registerDetectCorrelatedAnomalies(server: McpServer, { client, config }: ToolContext): void {
  server.registerTool(
    'detect_correlated_anomalies',
    {
      title: 'Detect correlated anomalies',
      description:
        'Compares the alerting panel against other panels (explicitly given, or auto-discovered from the metric ' +
        'reverse index via find_related_dashboards) over the same incident window. Ranks candidates by deviation ' +
        'strength, label overlap with the primary alert, and how closely their anomaly onset lines up with the ' +
        'primary\'s — a triage heuristic for blast radius, not a statistical proof of causation.',
      inputSchema: {
        primaryDashboardUid: z.string(),
        primaryPanelId: z.number(),
        startsAtMs: z.number(),
        endsAtMs: z.number().optional(),
        primaryLabels: z.record(z.string()).optional().describe('Alert labels, used for relevance ranking'),
        candidates: z
          .array(z.object({ dashboardUid: z.string(), panelId: z.number() }))
          .optional()
          .describe('Panels to check; omit to auto-discover via the metric reverse index'),
        variableOverrides: z.record(z.array(z.string())).optional(),
        limit: z.number().optional().default(10),
      },
      annotations: { readOnlyHint: true, title: 'Detect correlated anomalies' },
    },
    async ({ primaryDashboardUid, primaryPanelId, startsAtMs, endsAtMs, primaryLabels, candidates, variableOverrides, limit }) => {
      try {
        return await withAudit(
          'detect_correlated_anomalies',
          { primaryDashboardUid, primaryPanelId, startsAtMs, endsAtMs },
          config,
          async () => {
            const windowSet = computeWindows({ startsAtMs, endsAtMs, controlOffsets: [] });
            const overrides = variableOverrides ?? {};

            const primaryResolved = await resolvePanelForWindow(
              client,
              primaryDashboardUid,
              primaryPanelId,
              overrides,
              windowSet.incident,
            );
            const primaryIncident = await executeQueryWindow(client, primaryResolved.targets, windowSet.incident, config);
            const primaryPreWindowResolved = await resolvePanelForWindow(
              client,
              primaryDashboardUid,
              primaryPanelId,
              overrides,
              windowSet.preWindow,
            );
            const primaryPreWindow = await executeQueryWindow(client, primaryPreWindowResolved.targets, windowSet.preWindow, config);

            const primaryOnsets = primaryIncident.series
              .map((s) => {
                const baseline = computeStats(
                  primaryPreWindow.series.find((p) => seriesKey(p) === seriesKey(s))?.points ?? [],
                );
                return detectOnset(s.points, baseline);
              })
              .filter((t): t is number => t !== undefined);
            const primaryOnsetMs = primaryOnsets.length ? Math.min(...primaryOnsets) : undefined;

            const effectiveLabels = primaryLabels ?? {};

            let candidateRefs = candidates;
            if (!candidateRefs) {
              const index = await getOrBuildIndex(client, config, {});
              const metricNames = new Set(
                primaryResolved.panel.targets.flatMap((t) => extractQueryInfo(t.raw).metricNames),
              );
              const seen = new Set<string>();
              candidateRefs = [];
              for (const metric of metricNames) {
                for (const entry of index.entriesByMetric[metric] ?? []) {
                  if (entry.dashboardUid === primaryDashboardUid && entry.panelId === primaryPanelId) continue;
                  const key = `${entry.dashboardUid}|${entry.panelId}`;
                  if (seen.has(key)) continue;
                  seen.add(key);
                  candidateRefs.push({ dashboardUid: entry.dashboardUid, panelId: entry.panelId });
                }
              }
            }
            candidateRefs = candidateRefs.slice(0, Math.max(limit! * 3, 15));

            const candidateInputs: CorrelationCandidateInput[] = [];
            const settled = await Promise.allSettled(
              candidateRefs.map(async (ref) => {
                const incidentResolved = await resolvePanelForWindow(client, ref.dashboardUid, ref.panelId, {}, windowSet.incident);
                const incidentResult = await executeQueryWindow(client, incidentResolved.targets, windowSet.incident, config);
                const preResolved = await resolvePanelForWindow(client, ref.dashboardUid, ref.panelId, {}, windowSet.preWindow);
                const preResult = await executeQueryWindow(client, preResolved.targets, windowSet.preWindow, config);
                return { ref, dashboard: incidentResolved.dashboard, panel: incidentResolved.panel, incidentResult, preResult };
              }),
            );

            for (const outcome of settled) {
              if (outcome.status !== 'fulfilled') continue;
              const { ref, dashboard, panel, incidentResult, preResult } = outcome.value;
              for (const series of incidentResult.series) {
                const preSeries = preResult.series.find((s) => seriesKey(s) === seriesKey(series));
                candidateInputs.push({
                  dashboardUid: ref.dashboardUid,
                  dashboardTitle: dashboard.title,
                  panelId: ref.panelId,
                  panelTitle: panel.title,
                  labels: series.labels,
                  incidentPoints: series.points,
                  preWindowPoints: preSeries?.points ?? [],
                });
              }
            }

            const ranked = rankCorrelatedAnomalies(candidateInputs, effectiveLabels, primaryOnsetMs);
            const result = {
              primaryOnsetMs,
              candidatesChecked: candidateRefs.length,
              correlated: ranked.slice(0, limit),
            };
            return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns), null, 2) }] };
          },
        );
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
