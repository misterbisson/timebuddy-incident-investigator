import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { epochMsSchema, resolveLogToolClient, logSearchUrlFor, windowSizeWarning } from './shared.js';
import { correlateLogs } from '../logs/correlate.js';
import { enforceWindowLimit, clampLogLines } from '../security/limits.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

export function registerCorrelateLogs(server: McpServer, { logRegistry, config }: ToolContext): void {
  server.registerTool(
    'correlate_logs',
    {
      title: 'Correlate logs',
      description:
        'Joins two or more log queries on shared fields over one bounded, historical window on a single Graylog ' +
        'connection — e.g. matching a frontend request to its backend handler by request_id. Pass "query" using ' +
        'log-correlator\'s PromQL-inspired syntax: `graylog(service:frontend)[5m] and on(request_id) ' +
        'graylog(service:backend)[5m]`. The "[duration]" after each graylog(...) term is required syntax but has ' +
        'no effect on which data is fetched — every graylog(...) term in the query is answered from the same ' +
        'fixed startsAtMs/endsAtMs window below, not a relative lookback from now, so pick any short duration ' +
        '(e.g. [5m]) for each term regardless of how wide the actual window is. Supported join operators: "and" ' +
        '(inner — only events present on both sides), "or" (left — all left-side events, matched right-side ones ' +
        'attached), "unless" (anti-join — left-side events with no match on the right, e.g. requests with no ' +
        'corresponding backend log). Only joins queries against one connection; call this once per Graylog ' +
        'connection if you need to compare across two.',
      inputSchema: {
        connection: z.string().optional().describe('Which log connection to query; omit if only one is configured'),
        query: z.string().describe('A log-correlator join query, e.g. "graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]"'),
        startsAtMs: epochMsSchema.describe('Window start — epoch-ms or an ISO 8601 date/time'),
        endsAtMs: epochMsSchema.optional().describe('Window end — epoch-ms or an ISO 8601 date/time; defaults to now'),
        streamId: z.string().optional().describe('Restrict every graylog(...) term to one Graylog stream id; defaults to the connection\'s configured stream, if any'),
        limit: z.number().optional().describe(`Max log lines fetched per graylog(...) term before joining (capped at ${config.maxLogLines})`),
      },
      annotations: { readOnlyHint: true, title: 'Correlate logs' },
    },
    async ({ connection, query, startsAtMs, endsAtMs, streamId, limit }) => {
      let url: string | undefined;
      try {
        return await withAudit('correlate_logs', { connection, query }, config, async () => {
          const { client, connectionId } = resolveLogToolClient(logRegistry, { connection });
          const resolvedEndsAtMs = endsAtMs ?? Date.now();
          const window = { label: 'correlate', fromMs: startsAtMs, toMs: resolvedEndsAtMs };
          enforceWindowLimit(window, config);
          url = logSearchUrlFor(logRegistry, connectionId, query, { fromMs: startsAtMs, toMs: resolvedEndsAtMs, streamId });

          const correlated = await correlateLogs({
            client,
            query,
            fromMs: startsAtMs,
            toMs: resolvedEndsAtMs,
            streamId,
            limit: clampLogLines(limit, config),
          });

          const result = {
            connectionId,
            correlated,
            correlatedCount: correlated.length,
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
