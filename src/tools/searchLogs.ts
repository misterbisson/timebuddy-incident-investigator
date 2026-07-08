import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { epochMsSchema, resolveLogToolClient, logSearchUrlFor, windowSizeWarning } from './shared.js';
import { enforceWindowLimit, clampLogLines } from '../security/limits.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

export function registerSearchLogs(server: McpServer, { logRegistry, config }: ToolContext): void {
  server.registerTool(
    'search_logs',
    {
      title: 'Search logs',
      description:
        'Searches one Graylog connection for a bounded, historical time window — the log-side counterpart to ' +
        'execute_query_window. Unlike a live log tail, this always queries a fixed startsAtMs/endsAtMs range, so ' +
        'it works just as well for an incident from days ago as for one from five minutes ago. Pass "query" using ' +
        'Graylog\'s search syntax (e.g. "service:frontend AND level:ERROR"). Pass "streamId" to scope to one ' +
        'stream (see list_log_sources for available streams); omit it to search across all streams the ' +
        'connection\'s credentials can see. Use find_related_dashboards/list_datasources\' connectionTags to pick ' +
        'which log "connection" pairs with the Grafana connection already in play, rather than guessing.',
      inputSchema: {
        connection: z.string().optional().describe('Which log connection to search; omit if only one is configured'),
        query: z.string().describe('Graylog search query, e.g. "service:frontend AND level:ERROR"'),
        startsAtMs: epochMsSchema.describe('Window start — epoch-ms or an ISO 8601 date/time'),
        endsAtMs: epochMsSchema.optional().describe('Window end — epoch-ms or an ISO 8601 date/time; defaults to now'),
        streamId: z.string().optional().describe('Restrict to one Graylog stream id; defaults to the connection\'s configured stream, if any'),
        limit: z.number().optional().describe(`Max log lines to return (capped at ${config.maxLogLines})`),
      },
      annotations: { readOnlyHint: true, title: 'Search logs' },
    },
    async ({ connection, query, startsAtMs, endsAtMs, streamId, limit }) => {
      let url: string | undefined;
      try {
        return await withAudit('search_logs', { connection, query }, config, async () => {
          const { client, connectionId } = resolveLogToolClient(logRegistry, { connection });
          const resolvedEndsAtMs = endsAtMs ?? Date.now();
          const window = { label: 'search', fromMs: startsAtMs, toMs: resolvedEndsAtMs };
          enforceWindowLimit(window, config);
          url = logSearchUrlFor(logRegistry, connectionId, query, { fromMs: startsAtMs, toMs: resolvedEndsAtMs, streamId });

          const response = await client.searchAbsolute({
            query,
            fromMs: startsAtMs,
            toMs: resolvedEndsAtMs,
            streamId,
            limit: clampLogLines(limit, config),
          });

          const result = {
            connectionId,
            totalResults: response.total_results,
            messages: response.messages.map((m) => m.message),
            url,
            warning: windowSizeWarning(startsAtMs, endsAtMs, resolvedEndsAtMs),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        const message = `Error: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: 'text' as const, text: url ? `${message}\n\nGraylog search: ${url}` : message }], isError: true };
      }
    },
  );
}
