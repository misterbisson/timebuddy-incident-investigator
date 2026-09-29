import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { epochMsSchema, logSearchUrlFor, recordLogActivity, toolErrorResult, windowSizeWarning } from './shared.js';
import { clampLogLimit, enforceWindowLimit } from '../security/limits.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';
import { resolveLogSource } from '../logs/sources.js';
import { searchLoki } from '../logs/loki.js';
import { buildExploreUrl } from '../grafana/urlBuilder.js';

export function registerSearchLogs(server: McpServer, { registry, logRegistry, config, activityLog }: ToolContext): void {
  server.registerTool(
    'search_logs',
    {
      title: 'Search logs',
      description:
        'Searches one log source for log messages in a fixed time window. A log source is either a Graylog ' +
        'connection (query in Graylog\'s own syntax, e.g. "service:frontend AND level:ERROR") or a Loki datasource ' +
        'reached through a Grafana connection (query in LogQL: a stream selector plus any pipeline, e.g. ' +
        '{app="frontend"} |= "error" | json | level="error"). list_log_sources lists both kinds with their ids ' +
        'and sourceType — write the query in that source\'s language. Use identifiers pulled from a metric ' +
        'investigation (a hostname, IP, product string, request/trace id) to narrow the search to what actually ' +
        'matters for this incident, rather than a bare wildcard/selector over the whole window. Graylog only: pass ' +
        '"streamId" to restrict the search to one stream (or configure a default one on the connection). Returns ' +
        'each matching message\'s timestamp and message text plus its fields (Graylog) or labels (Loki), and a ' +
        'clickable URL (a Graylog search, or a Grafana Explore link for Loki). A Loki search returns newest lines ' +
        'first and reports no total match count, so "truncated": true means the line cap was reached and more ' +
        'lines likely match. Only Graylog\'s legacy (pre-6.x) search API is supported — see README\'s "Known ' +
        'limitations".',
      inputSchema: {
        query: z
          .string()
          .describe(
            'In the log source\'s own language: Graylog syntax, e.g. "service:frontend AND level:ERROR" (bare "*" ' +
              'matches everything), or a LogQL log query for a Loki source, e.g. {app="frontend"} |= "error"',
          ),
        startsAtMs: epochMsSchema.describe('Search window start — epoch ms or an ISO 8601 date/time'),
        endsAtMs: epochMsSchema.optional().describe('Search window end — epoch ms or ISO 8601; defaults to now'),
        streamId: z
          .string()
          .optional()
          .describe('Graylog only: restrict the search to one stream; overrides the connection\'s own default streamId if it has one'),
        limit: z.number().int().positive().optional().describe(`Max messages to return (capped at ${config.maxLogLines})`),
        connection: z
          .string()
          .optional()
          .describe('Log source id from list_log_sources (a Graylog connection id, or <grafanaConnection>/<datasourceUid> for Loki); omit when exactly one exists'),
      },
      annotations: { readOnlyHint: true, title: 'Search logs' },
    },
    async ({ query, startsAtMs, endsAtMs, streamId, limit, connection }) => {
      try {
        return await withAudit('search_logs', { query, startsAtMs, endsAtMs, streamId, connection }, config, async () => {
          const resolvedEndsAtMs = endsAtMs ?? Date.now();
          // Same hard caps the metric-query tools enforce: reject a window wider
          // than MAX_LOOKBACK_HOURS or one that's reversed/zero-length before it
          // ever reaches a log source. windowSizeWarning below is only advisory.
          enforceWindowLimit({ label: 'log search', fromMs: startsAtMs, toMs: resolvedEndsAtMs }, config);
          const warning = windowSizeWarning(startsAtMs, endsAtMs, resolvedEndsAtMs);
          const clampedLimit = clampLogLimit(limit, config);
          const resolved = await resolveLogSource(logRegistry, registry, connection);

          if (resolved.sourceType === 'loki') {
            const { source } = resolved;
            if (streamId !== undefined) {
              throw new Error(
                '"streamId" is Graylog-only — a Loki search is scoped by its own stream selector, e.g. ' +
                  '{app="checkout"}. Drop streamId and put the scope in the query.',
              );
            }
            const searched = await searchLoki(resolved.client, {
              datasourceUid: source.datasourceUid,
              query,
              fromMs: startsAtMs,
              toMs: resolvedEndsAtMs,
              limit: clampedLimit,
            });
            const url = buildExploreUrl(resolved.grafanaUrl, {
              datasourceUid: source.datasourceUid,
              datasourceType: 'loki',
              query: searched.statement,
              fromMs: startsAtMs,
              toMs: resolvedEndsAtMs,
            });
            const result = {
              connectionId: source.id,
              sourceType: 'loki' as const,
              grafanaConnection: source.grafanaConnection,
              datasource: { uid: source.datasourceUid, name: source.name },
              returned: searched.lines.length,
              truncated: searched.truncated,
              ...(searched.truncated
                ? {
                    truncatedNote:
                      `Returned the ${clampedLimit}-line cap, newest first. Loki reports no total match count, so ` +
                      'more lines likely match in this window — narrow the query or window rather than reading ' +
                      'this as the whole picture.',
                  }
                : {}),
              messages: searched.lines,
              url,
              ...(warning ? { warning } : {}),
            };
            activityLog?.record({
              kind: 'log',
              sourceType: 'loki',
              toolName: 'search_logs',
              connectionId: source.id,
              connectionName: `${source.name} (${resolved.grafanaName})`,
              query: searched.statement,
              resultCount: searched.lines.length,
              url,
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
          }

          const connectionId = resolved.source.id;
          const response = await resolved.client.searchAbsolute({
            query,
            fromMs: startsAtMs,
            toMs: resolvedEndsAtMs,
            streamId,
            limit: clampedLimit,
          });

          const url = logSearchUrlFor(logRegistry, connectionId, {
            query,
            fromMs: startsAtMs,
            toMs: resolvedEndsAtMs,
            streamId,
          });

          const result = {
            connectionId,
            sourceType: 'graylog' as const,
            totalResults: response.total_results,
            messages: response.messages.map((w) => w.message),
            url,
            ...(warning ? { warning } : {}),
          };
          recordLogActivity(logRegistry, activityLog, {
            toolName: 'search_logs',
            connectionId,
            query,
            streamId,
            resultCount: response.total_results,
            url,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        return toolErrorResult(err, config);
      }
    },
  );
}
