import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import type { GrafanaClient } from '../grafana/client.js';
import type { ResolvedTarget } from '../dashboards/panelQueries.js';
import { executeQueryWindow } from '../query/executor.js';
import { classifyInfluxQL } from '../query/adhocGuard.js';
import { computeStats } from '../analysis/baseline.js';
import { clampSeriesPoints } from '../security/limits.js';
import { buildExploreUrl } from '../grafana/urlBuilder.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';
import { epochMsSchema, resolveToolClient, toolErrorResult } from './shared.js';

/**
 * The only datasource types this tool knows how to guard. A type absent from
 * here is refused even when a workspace's policy names it, because
 * authorization and *verifiability* are different questions: a policy says the
 * operator is willing, this map says we can actually tell a read from a write in
 * that query language.
 *
 * Raw-SQL datasource types (postgres/mysql/mssql) are deliberately absent and
 * should stay that way unless someone writes a real guard for them — their query
 * body is arbitrary SQL over a connection whose credential we can't inspect, so
 * "begins with SELECT" is a much weaker claim there than in InfluxQL (CTEs that
 * write, stored procedures, multiple result sets).
 */
const GUARDABLE_TYPES: Record<string, (query: string) => ReturnType<typeof classifyInfluxQL>> = {
  influxdb: classifyInfluxQL,
};

/**
 * Resolves the datasource to query and checks it against the workspace's policy.
 * Split out so the refusal path is one place and every refusal names both what
 * was asked and what is allowed — a bare "not permitted" gets retried blindly,
 * while a message listing the authorized types gets corrected or abandoned.
 */
async function resolveAuthorizedDatasource(
  client: GrafanaClient,
  requestedUid: string,
  authorizedTypes: string[],
): Promise<{ uid: string; type: string }> {
  if (authorizedTypes.length === 0) {
    throw new Error(
      'This connection is not authorized for ad-hoc queries. Authorization is per-workspace: it comes from a ' +
        '--allow-adhoc-queries=<host>:<datasourceType> launch flag (typically in the repo\'s .mcp.json), not from ' +
        'anything settable at runtime. Use the dashboard-derived tools (resolve_panel_queries, ' +
        'execute_query_window) against this connection instead.',
    );
  }
  const datasources = await client.listDatasources();
  const found = datasources.find((d) => d.uid === requestedUid);
  if (!found) {
    throw new Error(
      `No datasource with uid "${requestedUid}" on this connection. Call list_datasources to see what exists.`,
    );
  }
  const type = found.type.toLowerCase();
  if (!authorizedTypes.includes(type)) {
    throw new Error(
      `Datasource "${found.name}" is type "${type}", which this workspace is not authorized to query ad-hoc. ` +
        `Authorized here: ${authorizedTypes.join(', ')}.`,
    );
  }
  if (!(type in GUARDABLE_TYPES)) {
    throw new Error(
      `Ad-hoc queries against "${type}" datasources are not supported, even though this workspace authorizes ` +
        `them: there is no read-only statement guard for that query language yet, and running unguarded query ` +
        `text is exactly what this tool exists to avoid. Supported: ${Object.keys(GUARDABLE_TYPES).join(', ')}.`,
    );
  }
  return { uid: found.uid, type };
}

export function registerExecuteAdhocQuery(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'execute_adhoc_query',
    {
      title: 'Execute an ad-hoc query',
      description:
        'Runs a query you write yourself against a datasource, over an explicit time window, and returns the ' +
        'resulting series plus a Grafana Explore URL that re-runs exactly that query. Unlike every other query ' +
        'tool here, the query text comes from you rather than from a dashboard a human authored and validated — ' +
        'so results carry provenance:"adhoc", and a verdict resting on them must say so. Prefer the ' +
        'dashboard-derived path first: find_related_dashboards / resolve_panel_queries / execute_query_window ' +
        'reproduce what the service owners actually chose to measure, including aggregation and retention ' +
        'policy choices that are easy to get subtly wrong by hand. Reach for this only when that path came up ' +
        'empty, or when iterating on a query you intend to put on a dashboard. Read-only: only single-statement ' +
        'SELECT/SHOW queries are accepted, and only against datasource types this workspace explicitly ' +
        'authorized. Goes through the same connection resolution, limits, redaction, and audit logging as every ' +
        'other tool.',
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .max(8000)
          .describe('The query text. InfluxQL only for now; must be a single SELECT or SHOW statement'),
        datasourceUid: z.string().describe('Which datasource to query — from list_datasources'),
        fromMs: epochMsSchema.describe('Window start (epoch ms or ISO 8601)'),
        toMs: epochMsSchema.describe('Window end (epoch ms or ISO 8601)'),
        includePoints: z
          .boolean()
          .optional()
          .default(true)
          .describe('Set false to return only per-series stats and the Explore URL, omitting raw points'),
        connection: z.string().optional().describe('Which Grafana connection to use; omit when only one is configured'),
      },
      annotations: { readOnlyHint: true, title: 'Execute an ad-hoc query' },
    },
    async ({ query, datasourceUid, fromMs, toMs, includePoints, connection }) => {
      // One mutable audit payload, filled in as the call progresses.
      // appendAuditRecord serializes it only after this callback settles
      // (success or throw), so a URL attached mid-flight still lands in
      // audit.jsonl — which is what makes a *refused* or failing query
      // reproducible too, and those are the ones an auditor most wants to
      // replay. withAudit logs argsSummary, never the result, so this is the
      // only channel that survives a throw.
      const auditArgs: Record<string, unknown> = { query, datasourceUid, fromMs, toMs, connection };
      let exploreUrl: string | undefined;
      try {
        return await withAudit(
          'execute_adhoc_query',
          auditArgs,
          config,
          async () => {
            const { client, connectionId } = resolveToolClient(registry, { connection });
            const authorizedTypes = registry.adhocDatasourceTypes(connectionId);
            const datasource = await resolveAuthorizedDatasource(client, datasourceUid, authorizedTypes);

            const baseUrl = registry.list().find((c) => c.id === connectionId)?.url;
            if (baseUrl) {
              exploreUrl = buildExploreUrl(baseUrl, {
                datasourceUid: datasource.uid,
                datasourceType: datasource.type,
                query,
                fromMs,
                toMs,
              });
              auditArgs.exploreUrl = exploreUrl;
            }

            const verdict = GUARDABLE_TYPES[datasource.type]!(query);
            if (!verdict.allowed) {
              throw new Error(`Query refused: ${verdict.reason}`);
            }

            const target: ResolvedTarget = {
              refId: 'A',
              datasourceUid: datasource.uid,
              raw: { refId: 'A', query: verdict.statement, rawQuery: true, resultFormat: 'time_series' },
            };
            // executeQueryWindow applies enforceWindowLimit and
            // clampMaxDataPoints itself, so an ad-hoc window is bounded by
            // exactly the same caps a replayed panel window is.
            const executed = await executeQueryWindow(
              client,
              [target],
              { label: 'adhoc', fromMs, toMs },
              config,
            );

            const clamped = clampSeriesPoints(executed.series, config);
            const result = {
              connection: connectionId,
              datasource: { uid: datasource.uid, type: datasource.type },
              // Marked on the result, not just documented: analysis/summarize.ts
              // is deterministic on the assumption its inputs were
              // human-authored, so anything built on this has to be able to say
              // where it came from.
              provenance: 'adhoc' as const,
              query: verdict.statement,
              window: { fromMs, toMs },
              exploreUrl,
              series: clamped.map((s, i) => {
                const { points, ...rest } = s;
                return {
                  ...rest,
                  ...(includePoints ? { points } : {}),
                  stats: computeStats(executed.series[i]!.points),
                };
              }),
              errors: executed.errors,
            };
            return {
              content: [
                {
                  type: 'text' as const,
                  // exploreUrl is exempt from the customer-identifier patterns:
                  // redactString rewrites inside strings, so a match would
                  // return a broken link rather than a masked one — and it
                  // would mask nothing the model doesn't have, since the model
                  // wrote this query. See security/redact.ts's RedactOptions.
                  text: JSON.stringify(redact(result, config.redactionPatterns, { exempt: ['exploreUrl'] })),
                },
              ],
            };
          },
        );
      } catch (err) {
        // Deliberately not passing exploreUrl through here: toolErrorResult
        // labels its url "Dashboard/panel" (wrong for an Explore link) and
        // redacts it without the exemption, so a matched pattern would hand back
        // a mangled URL. The clean one is already in the audit record above.
        return toolErrorResult(err, config);
      }
    },
  );
}
