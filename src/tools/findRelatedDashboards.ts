import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { getOrBuildIndex } from '../index-builder/metricIndex.js';
import type { MetricIndex, MetricIndexEntry } from '../index-builder/store.js';
import { dashboardUrlFor, resolveToolClient } from './shared.js';
import type { ConnectionRegistry } from '../grafana/registry.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

function labelOverlap(target: Record<string, string>, entryLabels: Record<string, string[]>): number {
  let count = 0;
  for (const [key, value] of Object.entries(target)) {
    if (entryLabels[key]?.includes(value)) count++;
  }
  return count;
}

/** Case-insensitive substring match against the metric name and titles — for a human product/service term, not an exact metric or label. */
function queryMatches(query: string, metric: string, entry: MetricIndexEntry): boolean {
  const q = query.toLowerCase();
  return (
    metric.toLowerCase().includes(q) ||
    entry.dashboardTitle.toLowerCase().includes(q) ||
    (entry.panelTitle ?? '').toLowerCase().includes(q)
  );
}

export type Candidate = MetricIndexEntry & {
  matchedMetric?: string;
  labelOverlapCount: number;
  connectionId: string;
  /** Titles of real alert rules wired to this panel, if any — see AlertBackedPanelRef. */
  backingAlertRuleTitles: string[];
};

function alertRuleTitlesFor(index: MetricIndex, dashboardUid: string, panelId: number): string[] {
  return index.alertBackedPanels
    .filter((p) => p.dashboardUid === dashboardUid && p.panelId === panelId)
    .flatMap((p) => p.alertRules.map((r) => r.title));
}

export function searchIndex(
  index: MetricIndex,
  connectionId: string,
  opts: { metricName?: string; labels?: Record<string, string>; query?: string; excludeDashboardUid?: string },
): Candidate[] {
  const candidates: Candidate[] = [];
  const metricPool = opts.metricName
    ? { [opts.metricName]: index.entriesByMetric[opts.metricName] ?? [] }
    : index.entriesByMetric;

  for (const [metric, entries] of Object.entries(metricPool)) {
    for (const entry of entries) {
      if (opts.excludeDashboardUid && entry.dashboardUid === opts.excludeDashboardUid) continue;
      const overlap = opts.labels ? labelOverlap(opts.labels, entry.labels) : 0;
      const queryHit = opts.query ? queryMatches(opts.query, metric, entry) : false;
      if (opts.metricName || overlap > 0 || queryHit) {
        candidates.push({
          ...entry,
          matchedMetric: metric,
          labelOverlapCount: overlap,
          connectionId,
          backingAlertRuleTitles: alertRuleTitlesFor(index, entry.dashboardUid, entry.panelId),
        });
      }
    }
  }
  return candidates;
}

/** Alert-backed first (the strongest "this is actually relied on" signal), then by label overlap. */
function compareCandidates(a: Candidate, b: Candidate): number {
  const backedDiff = (b.backingAlertRuleTitles.length > 0 ? 1 : 0) - (a.backingAlertRuleTitles.length > 0 ? 1 : 0);
  return backedDiff !== 0 ? backedDiff : b.labelOverlapCount - a.labelOverlapCount;
}

/** Only includes a connection when its alert-rule crawl actually failed — see MetricIndex.alertRuleAccessError. */
export function collectAlertRuleAccessErrors(results: Array<{ connectionId: string; index: MetricIndex }>): Record<string, string> {
  return Object.fromEntries(
    results.filter((r) => r.index.alertRuleAccessError).map((r) => [r.connectionId, r.index.alertRuleAccessError!]),
  );
}

/** Attaches a clickable dashboard/panel URL to a bounded result list — called after slicing to `limit`, not before, so it never builds URLs for entries that get discarded anyway. */
function withUrls<T extends { dashboardUid: string; panelId: number; connectionId: string }>(
  registry: ConnectionRegistry,
  items: T[],
): Array<T & { url: string | undefined }> {
  return items.map((item) => ({ ...item, url: dashboardUrlFor(registry, item.connectionId, item.dashboardUid, { panelId: item.panelId }) }));
}

export function registerFindRelatedDashboards(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'find_related_dashboards',
    {
      title: 'Find related dashboards',
      description:
        'Searches the metric/measurement -> dashboard reverse index for panels using a given metric name, sharing ' +
        'label values (service, host, region, az, account, ...) with the alert, and/or matching a free-text "query" ' +
        'against metric names and dashboard/panel titles (e.g. a product or service name like "block storage" that ' +
        'is not itself a metric name or label value). Use this to find blast-radius candidates before running ' +
        'detect_correlated_anomalies, or as the general "where do I look for X" search. Always use this instead of ' +
        'reading any cached index/data files directly, even if you know or can find where they\'re stored on disk — ' +
        'this tool\'s output is redacted before it reaches you, a raw file read is not. The index is crawled from ' +
        'all dashboards and cached locally (default 6h TTL); pass forceRefresh to rebuild it now. Pass "connection" ' +
        'to search one Grafana connection; omit it to search every configured connection and merge results, tagged ' +
        'by connectionId. Each match includes backingAlertRuleTitles when a real Grafana alert rule is wired to that ' +
        'panel — the strongest signal that it\'s actually relied on rather than a test/scratch/deprecated dashboard ' +
        'that merely matched; alert-backed matches sort first. alertBackedDashboards is a standing overview of every ' +
        'alert-backed panel found, independent of metricName/labels/query — useful even with no search term, e.g. ' +
        'when just surveying what exists and is known-good. If alertBackedTotal is 0 or unexpectedly low, check ' +
        'alertRuleAccessErrors before concluding there simply are no alerts — it\'s only present for a connection ' +
        'when the alert-rule crawl itself failed (e.g. a permission-scoped token), which looks identical to "no ' +
        'alerts" unless you check this.',
      inputSchema: {
        metricName: z.string().optional().describe('Exact Prometheus metric name or InfluxDB measurement name'),
        labels: z.record(z.string()).optional().describe('Label/tag key-value pairs to match against, e.g. from the alert'),
        query: z.string().optional().describe('Free-text, case-insensitive substring match against metric names and dashboard/panel titles - for a product/service name you don\'t have an exact metric or label for'),
        excludeDashboardUid: z.string().optional().describe('Skip the alert\'s own dashboard'),
        forceRefresh: z.boolean().optional().describe('Rebuild the index instead of using the cached copy'),
        limit: z.number().optional().default(20).describe('Max matches and max brokenDatasources entries to return; see matchesTotal/brokenDatasourcesTotal for the untruncated counts'),
        connection: z.string().optional().describe('Search only this connection; omit to fan out across every configured connection'),
      },
      annotations: { readOnlyHint: true, title: 'Find related dashboards' },
    },
    async ({ metricName, labels, query, excludeDashboardUid, forceRefresh, limit, connection }) => {
      try {
        return await withAudit('find_related_dashboards', { metricName, labels, query }, config, async () => {
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
                candidates: searchIndex(index, connectionId, { metricName, labels, query, excludeDashboardUid }),
              };
            }),
          );

          const fulfilled = perConnection.filter(
            (r): r is PromiseFulfilledResult<{ connectionId: string; index: MetricIndex; candidates: Candidate[] }> =>
              r.status === 'fulfilled',
          );

          const allCandidates = fulfilled.flatMap((r) => r.value.candidates);
          allCandidates.sort(compareCandidates);

          const allBroken = fulfilled.flatMap((r) =>
            r.value.index.brokenDatasources.map((b) => ({ ...b, connectionId: r.value.connectionId })),
          );

          // Independent of metricName/labels/query — always surfaces what's
          // known to matter (wired to a real alert rule), same idea as
          // "explore" wanting an overview even with no search term given.
          const allAlertBacked = fulfilled
            .flatMap((r) => r.value.index.alertBackedPanels.map((p) => ({ ...p, connectionId: r.value.connectionId })))
            .sort((a, b) => b.alertRules.length - a.alertRules.length);

          // brokenDatasources in particular has no relevance ranking to sort
          // by (unlike matches) and can run into the tens of thousands of
          // entries on a large real Grafana estate — always cap both, and
          // report the untruncated counts so nothing is silently hidden.
          const alertRuleAccessErrors = collectAlertRuleAccessErrors(fulfilled.map((r) => r.value));

          const result = {
            indexBuiltAt: Object.fromEntries(fulfilled.map((r) => [r.value.connectionId, r.value.index.builtAt])),
            dashboardsScanned: Object.fromEntries(fulfilled.map((r) => [r.value.connectionId, r.value.index.dashboardsScanned])),
            matches: withUrls(registry, allCandidates.slice(0, limit)),
            matchesTotal: allCandidates.length,
            alertBackedDashboards: withUrls(registry, allAlertBacked.slice(0, limit)),
            alertBackedTotal: allAlertBacked.length,
            // Only present for connections where the alert-rule crawl itself
            // failed — lets a zero/low alertBackedTotal be told apart from
            // "we tried and there genuinely are none" vs. "we couldn't ask."
            alertRuleAccessErrors,
            brokenDatasources: withUrls(registry, allBroken.slice(0, limit)),
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
