import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { epochMsSchema, logSearchUrlFor, recordLogActivity, resolveLogToolClient, toolErrorResult, windowSizeWarning } from './shared.js';
import { correlateLogs } from '../logs/correlate.js';
import { joinShape } from '../logs/joinShape.js';
import { clampLogLimit, enforceWindowLimit } from '../security/limits.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

export function registerCorrelateLogs(server: McpServer, { logRegistry, config, activityLog }: ToolContext): void {
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
        'query actually matched ("complete") or only some did ("partial"), plus a per-stream "streams" array ' +
        '(fetched vs. total matched) and a top-level "truncated" flag when any stream hit the per-stream line cap — ' +
        'treat a truncated result as a partial view, not a complete count. An "unless" (anti-join) whose right side ' +
        'is truncated errors out instead of returning a possibly-inverted answer; narrow the query/window or raise ' +
        'the cap and retry.',
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
          // Every stream in the query runs against this one window, so enforce the
          // MAX_LOOKBACK_HOURS / non-positive-duration caps once here, before any
          // search reaches Graylog. windowSizeWarning below is only advisory.
          enforceWindowLimit({ label: 'log correlation', fromMs: startsAtMs, toMs: resolvedEndsAtMs }, config);
          const warning = windowSizeWarning(startsAtMs, endsAtMs, resolvedEndsAtMs);
          const clampedLimit = clampLogLimit(limit, config);

          const { events: correlated, streams } = await correlateLogs({
            client,
            query,
            fromMs: startsAtMs,
            toMs: resolvedEndsAtMs,
            streamId,
            limit: clampedLimit,
          });

          // A stream capped at `limit` gives the join a partial view. For an
          // `unless` (anti-join) a truncated *right* side is not just lossy —
          // it inverts the meaning: a left event whose match sits past the cap
          // gets reported as "unmatched" (e.g. "this frontend request never
          // reached the backend" when it did). Refuse rather than answer
          // wrongly. Inner/`and` and `or` only under-count, so those stay a
          // surfaced `truncated` flag rather than a hard error.
          const { joinType, rightSelectors } = joinShape(query);
          const truncatedStreams = streams.filter((s) => s.truncated);
          if (joinType === 'unless' && truncatedStreams.length > 0) {
            const rightTruncated = rightSelectors.length
              ? truncatedStreams.filter((s) => rightSelectors.includes(s.selector))
              : truncatedStreams; // couldn't identify sides — treat any truncation as unsafe
            if (rightTruncated.length > 0) {
              const detail = rightTruncated
                .map((s) => `"${s.selector}" fetched ${s.fetched} of ${s.total}`)
                .join('; ');
              throw new Error(
                `correlate_logs: the right-hand side of an "unless" anti-join was truncated at the ` +
                  `${config.maxLogLines}-line cap (${detail}). A truncated right side can report left events as ` +
                  `unmatched when a match exists beyond the cap, inverting the result — refusing rather than ` +
                  `returning a wrong answer. Narrow the query or window, raise MAX_LOG_LINES, or pass a smaller ` +
                  `"limit" per stream and retry.`,
              );
            }
          }

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
            streams,
            ...(truncatedStreams.length > 0 ? { truncated: true } : {}),
            url,
            ...(warning ? { warning } : {}),
          };
          recordLogActivity(logRegistry, activityLog, {
            toolName: 'correlate_logs',
            connectionId,
            query,
            streamId,
            resultCount: correlated.length,
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
