import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { getOrBuildIndex } from '../index-builder/metricIndex.js';
import type { MetricIndex, MetricIndexEntry } from '../index-builder/store.js';
import { resolveToolClient } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

function labelOverlap(target: Record<string, string>, entryLabels: Record<string, string[]>): number {
  let count = 0;
  for (const [key, value] of Object.entries(target)) {
    if (entryLabels[key]?.includes(value)) count++;
  }
  return count;
}

type Candidate = MetricIndexEntry & { matchedMetric?: string; labelOverlapCount: number; connectionId: string };

function searchIndex(
  index: MetricIndex,
  connectionId: string,
  opts: { metricName?: string; labels?: Record<string, string>; excludeDashboardUid?: string },
): Candidate[] {
  const candidates: Candidate[] = [];
  const metricPool = opts.metricName
    ? { [opts.metricName]: index.entriesByMetric[opts.metricName] ?? [] }
    : index.entriesByMetric;

  for (const [metric, entries] of Object.entries(metricPool)) {
    for (const entry of entries) {
      if (opts.excludeDashboardUid && entry.dashboardUid === opts.excludeDashboardUid) continue;
      const overlap = opts.labels ? labelOverlap(opts.labels, entry.labels) : 0;
      if (opts.metricName || overlap > 0) {
        candidates.push({ ...entry, matchedMetric: metric, labelOverlapCount: overlap, connectionId });
      }
    }
  }
  return candidates;
}

export function registerFindRelatedDashboards(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'find_related_dashboards',
    {
      title: 'Find related dashboards',
      description:
        'Searches the metric/measurement -> dashboard reverse index for panels using a given metric name and/or ' +
        'sharing label values (service, host, region, az, account, ...) with the alert. Use this to find blast-radius ' +
        'candidates before running detect_correlated_anomalies. The index is crawled from all dashboards and cached ' +
        'locally (default 6h TTL); pass forceRefresh to rebuild it now. Pass "connection" to search one Grafana ' +
        'connection; omit it to search every configured connection and merge results, tagged by connectionId.',
      inputSchema: {
        metricName: z.string().optional().describe('Prometheus metric name or InfluxDB measurement name'),
        labels: z.record(z.string()).optional().describe('Label/tag key-value pairs to match against, e.g. from the alert'),
        excludeDashboardUid: z.string().optional().describe('Skip the alert\'s own dashboard'),
        forceRefresh: z.boolean().optional().describe('Rebuild the index instead of using the cached copy'),
        limit: z.number().optional().default(20).describe('Max matches and max brokenDatasources entries to return; see matchesTotal/brokenDatasourcesTotal for the untruncated counts'),
        connection: z.string().optional().describe('Search only this connection; omit to fan out across every configured connection'),
      },
      annotations: { readOnlyHint: true, title: 'Find related dashboards' },
    },
    async ({ metricName, labels, excludeDashboardUid, forceRefresh, limit, connection }) => {
      try {
        return await withAudit('find_related_dashboards', { metricName, labels }, config, async () => {
          const connections = connection
            ? [resolveToolClient(registry, { connection }).connectionId]
            : registry.list().map((c) => c.id);

          const perConnection = await Promise.allSettled(
            connections.map(async (connectionId) => {
              const client = registry.get(connectionId);
              const index = await getOrBuildIndex(client, config, connectionId, { force: forceRefresh });
              return {
                connectionId,
                index,
                candidates: searchIndex(index, connectionId, { metricName, labels, excludeDashboardUid }),
              };
            }),
          );

          const fulfilled = perConnection.filter(
            (r): r is PromiseFulfilledResult<{ connectionId: string; index: MetricIndex; candidates: Candidate[] }> =>
              r.status === 'fulfilled',
          );

          const allCandidates = fulfilled.flatMap((r) => r.value.candidates);
          allCandidates.sort((a, b) => b.labelOverlapCount - a.labelOverlapCount);

          const allBroken = fulfilled.flatMap((r) =>
            r.value.index.brokenDatasources.map((b) => ({ ...b, connectionId: r.value.connectionId })),
          );

          // brokenDatasources in particular has no relevance ranking to sort
          // by (unlike matches) and can run into the tens of thousands of
          // entries on a large real Grafana estate — always cap both, and
          // report the untruncated counts so nothing is silently hidden.
          const result = {
            indexBuiltAt: Object.fromEntries(fulfilled.map((r) => [r.value.connectionId, r.value.index.builtAt])),
            dashboardsScanned: Object.fromEntries(fulfilled.map((r) => [r.value.connectionId, r.value.index.dashboardsScanned])),
            matches: allCandidates.slice(0, limit),
            matchesTotal: allCandidates.length,
            brokenDatasources: allBroken.slice(0, limit),
            brokenDatasourcesTotal: allBroken.length,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns), null, 2) }] };
        });
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
