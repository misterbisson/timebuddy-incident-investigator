import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { epochMsSchema, logSearchUrlFor, resolveLogToolClient, windowSizeWarning } from './shared.js';
import { correlateLogs } from '../logs/correlate.js';
import { clampLogLimit } from '../security/limits.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

export function registerCorrelateLogs(server: McpServer, { logRegistry, config }: ToolContext): void {
  server.registerTool(
    'correlate_logs',
    {
      title: 'Correlate logs',
      description:
        'Joins two (or more) Graylog searches on a shared field — e.g. matching a frontend request to the ' +
        'backend request it triggered by request_id — using a PromQL-inspired join query: ' +
        '\'graylog(service:frontend) and on(request_id) graylog(service:backend)\'. Supported operators: "and" ' +
        '(inner join, only matched pairs), "or" (union), "unless" (left-anti-join: events on the left with no ' +
        'match on the right — useful for "which frontend requests never reached the backend"). Every stream in the ' +
        'query runs against the same connection/window passed here; the "[5m]" window syntax the query language ' +
        'requires has no effect since every search already uses the fixed startsAtMs/endsAtMs window below, not a ' +
        'live tail. Returns each correlated group\'s joined events, join key/value, and whether every stream in the ' +
        'query actually matched ("complete") or only some did ("partial").',
      inputSchema: {
        query: z.string().describe('A log-correlator join query, e.g. "graylog(service:frontend) and on(request_id) graylog(service:backend)"'),
        startsAtMs: epochMsSchema.describe('Search window start — epoch ms or an ISO 8601 date/time'),
        endsAtMs: epochMsSchema.optional().describe('Search window end — epoch ms or ISO 8601; defaults to now'),
        streamId: z.string().optional().describe('Restrict every stream in the query to one Graylog stream; overrides the connection\'s own default streamId if it has one'),
        limit: z.number().optional().describe(`Max messages fetched per stream before joining (capped at ${config.maxLogLines})`),
        connection: z.string().optional().describe('Log connection id to use, when multiple are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Correlate logs' },
    },
    async ({ query, startsAtMs, endsAtMs, streamId, limit, connection }) => {
      try {
        return await withAudit('correlate_logs', { query, startsAtMs, endsAtMs, streamId }, config, async () => {
          const { client, connectionId } = resolveLogToolClient(logRegistry, { connection });
          const resolvedEndsAtMs = endsAtMs ?? Date.now();
          const warning = windowSizeWarning(startsAtMs, endsAtMs, resolvedEndsAtMs);
          const clampedLimit = clampLogLimit(limit, config);

          const correlated = await correlateLogs({
            client,
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
            correlated,
            correlatedCount: correlated.length,
            url,
            ...(warning ? { warning } : {}),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
