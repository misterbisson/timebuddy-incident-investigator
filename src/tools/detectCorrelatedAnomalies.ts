import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { computeWindows } from '../query/windows.js';
import { executeQueryWindow, type QuerySeries } from '../query/executor.js';
import { computeStats, detectOnset } from '../analysis/baseline.js';
import { rankCorrelatedAnomalies, type CorrelationCandidateInput } from '../analysis/correlation.js';
import { getOrBuildIndex } from '../index-builder/metricIndex.js';
import { extractQueryInfo } from '../index-builder/extract.js';
import { epochMsSchema, resolvePanelForWindow, resolveToolClient } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

function seriesKey(series: QuerySeries): string {
  const labelStr = Object.entries(series.labels).sort().map(([k, v]) => `${k}=${v}`).join(',');
  return `${series.refId}|${labelStr}`;
}

interface CandidateRef {
  dashboardUid: string;
  panelId: number;
  connectionId: string;
}

export function registerDetectCorrelatedAnomalies(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'detect_correlated_anomalies',
    {
      title: 'Detect correlated anomalies',
      description:
        'Compares the alerting panel against other panels (explicitly given, or auto-discovered from the metric ' +
        'reverse index via find_related_dashboards) over the same incident window. Ranks candidates by deviation ' +
        'strength, label overlap with the primary alert, and how closely their anomaly onset lines up with the ' +
        'primary\'s — a triage heuristic for blast radius, not a statistical proof of causation. When ' +
        'auto-discovering (candidates omitted), searches every configured Grafana connection, not just the ' +
        'primary panel\'s.',
      inputSchema: {
        primaryDashboardUid: z.string(),
        primaryPanelId: z.number(),
        startsAtMs: epochMsSchema.describe('Incident start — epoch ms or an ISO 8601 date/time'),
        endsAtMs: epochMsSchema.optional().describe('Incident end — epoch ms or ISO 8601'),
        primaryLabels: z.record(z.string()).optional().describe('Alert labels, used for relevance ranking'),
        candidates: z
          .array(z.object({ dashboardUid: z.string(), panelId: z.number(), connectionId: z.string().optional() }))
          .optional()
          .describe('Panels to check; omit to auto-discover via the metric reverse index. connectionId defaults to the primary panel\'s connection.'),
        variableOverrides: z.record(z.array(z.string())).optional(),
        limit: z.number().optional().default(10),
        connection: z.string().optional().describe('Connection id for the primary panel, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Detect correlated anomalies' },
    },
    async ({ primaryDashboardUid, primaryPanelId, startsAtMs, endsAtMs, primaryLabels, candidates, variableOverrides, limit, connection }) => {
      try {
        return await withAudit(
          'detect_correlated_anomalies',
          { primaryDashboardUid, primaryPanelId, startsAtMs, endsAtMs },
          config,
          async () => {
            const { client: primaryClient, connectionId: primaryConnectionId } = resolveToolClient(registry, { connection });
            const windowSet = computeWindows({ startsAtMs, endsAtMs, controlOffsets: [] });
            const overrides = variableOverrides ?? {};

            const primaryResolved = await resolvePanelForWindow(
              primaryClient,
              primaryDashboardUid,
              primaryPanelId,
              overrides,
              windowSet.incident,
            );
            const primaryIncident = await executeQueryWindow(primaryClient, primaryResolved.targets, windowSet.incident, config);
            const primaryPreWindowResolved = await resolvePanelForWindow(
              primaryClient,
              primaryDashboardUid,
              primaryPanelId,
              overrides,
              windowSet.preWindow,
            );
            const primaryPreWindow = await executeQueryWindow(primaryClient, primaryPreWindowResolved.targets, windowSet.preWindow, config);

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

            let candidateRefs: CandidateRef[];
            if (candidates) {
              candidateRefs = candidates.map((c) => ({ ...c, connectionId: c.connectionId ?? primaryConnectionId }));
            } else {
              const metricNames = new Set(
                primaryResolved.panel.targets.flatMap((t) => extractQueryInfo(t.raw).metricNames),
              );
              const seen = new Set<string>();
              candidateRefs = [];
              const perConnection = await Promise.allSettled(
                registry.list().map(async (conn) => {
                  const index = await getOrBuildIndex(registry.get(conn.id), config, conn.id, {});
                  return { connectionId: conn.id, index };
                }),
              );
              for (const outcome of perConnection) {
                if (outcome.status !== 'fulfilled') continue;
                const { connectionId, index } = outcome.value;
                for (const metric of metricNames) {
                  for (const entry of index.entriesByMetric[metric] ?? []) {
                    if (
                      connectionId === primaryConnectionId &&
                      entry.dashboardUid === primaryDashboardUid &&
                      entry.panelId === primaryPanelId
                    ) {
                      continue;
                    }
                    const key = `${connectionId}|${entry.dashboardUid}|${entry.panelId}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    candidateRefs.push({ dashboardUid: entry.dashboardUid, panelId: entry.panelId, connectionId });
                  }
                }
              }
            }
            candidateRefs = candidateRefs.slice(0, Math.max(limit! * 3, 15));

            const candidateInputs: (CorrelationCandidateInput & { connectionId: string })[] = [];
            const settled = await Promise.allSettled(
              candidateRefs.map(async (ref) => {
                const client = registry.get(ref.connectionId);
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
                  connectionId: ref.connectionId,
                });
              }
            }

            const ranked = rankCorrelatedAnomalies(candidateInputs, effectiveLabels, primaryOnsetMs);
            const result = {
              primaryConnectionId,
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
