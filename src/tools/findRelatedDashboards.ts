import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { getOrBuildIndex } from '../index-builder/metricIndex.js';
import type { MetricIndexEntry } from '../index-builder/store.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

function labelOverlap(target: Record<string, string>, entryLabels: Record<string, string[]>): number {
  let count = 0;
  for (const [key, value] of Object.entries(target)) {
    if (entryLabels[key]?.includes(value)) count++;
  }
  return count;
}

export function registerFindRelatedDashboards(server: McpServer, { client, config }: ToolContext): void {
  server.registerTool(
    'find_related_dashboards',
    {
      title: 'Find related dashboards',
      description:
        'Searches the metric/measurement -> dashboard reverse index for panels using a given metric name and/or ' +
        'sharing label values (service, host, region, az, account, ...) with the alert. Use this to find blast-radius ' +
        'candidates before running detect_correlated_anomalies. The index is crawled from all dashboards and cached ' +
        'locally (default 6h TTL); pass forceRefresh to rebuild it now.',
      inputSchema: {
        metricName: z.string().optional().describe('Prometheus metric name or InfluxDB measurement name'),
        labels: z.record(z.string()).optional().describe('Label/tag key-value pairs to match against, e.g. from the alert'),
        excludeDashboardUid: z.string().optional().describe('Skip the alert\'s own dashboard'),
        forceRefresh: z.boolean().optional().describe('Rebuild the index instead of using the cached copy'),
        limit: z.number().optional().default(20),
      },
      annotations: { readOnlyHint: true, title: 'Find related dashboards' },
    },
    async ({ metricName, labels, excludeDashboardUid, forceRefresh, limit }) => {
      try {
        return await withAudit('find_related_dashboards', { metricName, labels }, config, async () => {
          const index = await getOrBuildIndex(client, config, { force: forceRefresh });

          const candidates: Array<MetricIndexEntry & { matchedMetric?: string; labelOverlapCount: number }> = [];
          const metricPool = metricName
            ? { [metricName]: index.entriesByMetric[metricName] ?? [] }
            : index.entriesByMetric;

          for (const [metric, entries] of Object.entries(metricPool)) {
            for (const entry of entries) {
              if (excludeDashboardUid && entry.dashboardUid === excludeDashboardUid) continue;
              const overlap = labels ? labelOverlap(labels, entry.labels) : 0;
              if (metricName || overlap > 0) {
                candidates.push({ ...entry, matchedMetric: metric, labelOverlapCount: overlap });
              }
            }
          }

          candidates.sort((a, b) => b.labelOverlapCount - a.labelOverlapCount);

          const result = {
            indexBuiltAt: index.builtAt,
            dashboardsScanned: index.dashboardsScanned,
            matches: candidates.slice(0, limit),
            brokenDatasources: index.brokenDatasources,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns), null, 2) }] };
        });
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
