import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { epochMsSchema, logSearchUrlFor, resolveLogToolClient, toolErrorResult, windowSizeWarning } from './shared.js';
import { clampLogLimit, enforceWindowLimit } from '../security/limits.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

export function registerSearchLogs(server: McpServer, { logRegistry, config }: ToolContext): void {
  server.registerTool(
    'search_logs',
    {
      title: 'Search logs',
      description:
        'Searches a Graylog connection for log messages in a fixed time window, using Graylog\'s own query syntax ' +
        '(e.g. "service:frontend AND level:ERROR"). Use identifiers pulled from a metric investigation (a ' +
        'hostname, IP, product string, request/trace id) to narrow the search to what actually matters for this ' +
        'incident, rather than a bare wildcard over the whole window. Pass "streamId" to restrict the search to one ' +
        'stream (or configure a default one on the connection itself). Returns each matching message\'s timestamp, ' +
        'source, message text, and any other indexed fields Graylog returned, plus a clickable Graylog search URL. ' +
        'Only Graylog\'s legacy (pre-6.x) search API is supported — see README\'s "Known limitations".',
      inputSchema: {
        query: z.string().describe('Graylog query syntax, e.g. "service:frontend AND level:ERROR" (bare "*" matches everything in the window)'),
        startsAtMs: epochMsSchema.describe('Search window start — epoch ms or an ISO 8601 date/time'),
        endsAtMs: epochMsSchema.optional().describe('Search window end — epoch ms or ISO 8601; defaults to now'),
        streamId: z.string().optional().describe('Restrict the search to one stream; overrides the connection\'s own default streamId if it has one'),
        limit: z.number().optional().describe(`Max messages to return (capped at ${config.maxLogLines})`),
        connection: z.string().optional().describe('Log connection id to use, when multiple are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Search logs' },
    },
    async ({ query, startsAtMs, endsAtMs, streamId, limit, connection }) => {
      try {
        return await withAudit('search_logs', { query, startsAtMs, endsAtMs, streamId }, config, async () => {
          const { client, connectionId } = resolveLogToolClient(logRegistry, { connection });
          const resolvedEndsAtMs = endsAtMs ?? Date.now();
          // Same hard caps the metric-query tools enforce: reject a window wider
          // than MAX_LOOKBACK_HOURS or one that's reversed/zero-length before it
          // ever reaches Graylog. windowSizeWarning below is only advisory.
          enforceWindowLimit({ label: 'log search', fromMs: startsAtMs, toMs: resolvedEndsAtMs }, config);
          const warning = windowSizeWarning(startsAtMs, endsAtMs, resolvedEndsAtMs);
          const clampedLimit = clampLogLimit(limit, config);

          const response = await client.searchAbsolute({
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
            totalResults: response.total_results,
            messages: response.messages.map((w) => w.message),
            url,
            ...(warning ? { warning } : {}),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        return toolErrorResult(err, config);
      }
    },
  );
}
