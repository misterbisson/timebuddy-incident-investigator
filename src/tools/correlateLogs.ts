import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { epochMsSchema, logSearchUrlFor, recordLogActivity, toolErrorResult, windowSizeWarning } from './shared.js';
import { correlateLogs, type CorrelateTarget } from '../logs/correlate.js';
import { resolveLogSource } from '../logs/sources.js';
import { buildExploreUrl } from '../grafana/urlBuilder.js';
import { joinShape } from '../logs/joinShape.js';
import { clampLogLimit, enforceWindowLimit } from '../security/limits.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

export function registerCorrelateLogs(server: McpServer, { registry, logRegistry, config, activityLog }: ToolContext): void {
  server.registerTool(
    'correlate_logs',
    {
      title: 'Correlate logs',
      description:
        'Joins two (or more) log searches on a shared field — e.g. matching a frontend request to the ' +
        'backend request it triggered by request_id — using a PromQL-inspired join query: ' +
        '\'graylog(service:frontend) and on(request_id) graylog(service:backend)\' against a Graylog source, or ' +
        '\'loki({app="frontend"}) and on(request_id) loki({app="backend"})\' against a Loki one (see ' +
        'list_log_sources; write every stream with its source\'s name). A loki(...) stream takes a bare stream ' +
        'selector only — no pipeline stages — so each event is joinable on its stream labels plus the fields ' +
        'Loki\'s own "| json" would extract from a JSON line (nested keys joined with "_", e.g. ' +
        'error_code). Supported operators: "and" ' +
        '(inner join, only matched pairs), "or" (union), "unless" (left-anti-join: events on the left with no ' +
        'match on the right — useful for "which frontend requests never reached the backend"). Every stream in the ' +
        'query runs against the same connection/window passed here; the "[5m]" window syntax the query language ' +
        'requires has no effect since every search already uses the fixed startsAtMs/endsAtMs window below, not a ' +
        'live tail. Returns each correlated group\'s joined events, join key/value, and whether every stream in the ' +
        'query actually matched ("complete") or only some did ("partial"), plus a per-stream "streams" array ' +
        '(fetched vs. total matched; Loki reports no total, so a Loki stream is "truncated" whenever it hit the ' +
        'cap) and a top-level "truncated" flag when any stream hit the per-stream line cap — ' +
        'treat a truncated result as a partial view, not a complete count. An "unless" (anti-join) whose right side ' +
        'is truncated errors out instead of returning a possibly-inverted answer; narrow the query/window or raise ' +
        'the cap and retry.',
      inputSchema: {
        query: z.string().describe('A log-correlator join query, e.g. "graylog(service:frontend) and on(request_id) graylog(service:backend)"'),
        startsAtMs: epochMsSchema.describe('Search window start — epoch ms or an ISO 8601 date/time'),
        endsAtMs: epochMsSchema.optional().describe('Search window end — epoch ms or ISO 8601; defaults to now'),
        streamId: z.string().optional().describe('Graylog only: restrict every stream in the query to one Graylog stream; overrides the connection\'s own default streamId if it has one'),
        limit: z.number().optional().describe(`Max messages fetched per stream before joining (capped at ${config.maxLogLines})`),
        connection: z
          .string()
          .optional()
          .describe('Log source id from list_log_sources (a Graylog connection id, or <grafanaConnection>/<datasourceUid> for Loki); omit when exactly one exists'),
      },
      annotations: { readOnlyHint: true, title: 'Correlate logs' },
    },
    async ({ query, startsAtMs, endsAtMs, streamId, limit, connection }) => {
      try {
        return await withAudit('correlate_logs', { query, startsAtMs, endsAtMs, streamId, connection }, config, async () => {
          const resolvedEndsAtMs = endsAtMs ?? Date.now();
          // Every stream in the query runs against this one window, so enforce the
          // MAX_LOOKBACK_HOURS / non-positive-duration caps once here, before any
          // search reaches Graylog. windowSizeWarning below is only advisory.
          enforceWindowLimit({ label: 'log correlation', fromMs: startsAtMs, toMs: resolvedEndsAtMs }, config);
          const warning = windowSizeWarning(startsAtMs, endsAtMs, resolvedEndsAtMs);
          const clampedLimit = clampLogLimit(limit, config);
          const resolved = await resolveLogSource(logRegistry, registry, connection);
          const connectionId = resolved.source.id;

          // Checked up front: the engine registers one adapter, named for this
          // source's kind, so a stream written as graylog(...) against a Loki
          // source would otherwise fail inside the engine with no hint that the
          // query and the source disagree.
          const shape = await joinShape(query);
          const mismatched = shape.sources.filter((s) => s !== resolved.sourceType);
          if (mismatched.length > 0) {
            throw new Error(
              `"${connectionId}" is a ${resolved.sourceType} log source, but the query writes stream(s) as ` +
                `${[...new Set(mismatched)].map((s) => `${s}(...)`).join(', ')}. Write every stream as ` +
                `${resolved.sourceType}(...) — ${resolved.sourceType === 'loki' ? 'a bare stream selector, e.g. loki({app="frontend"})' : 'Graylog query syntax, e.g. graylog(service:frontend)'}.`,
            );
          }
          if (resolved.sourceType === 'loki' && streamId !== undefined) {
            throw new Error(
              '"streamId" is Graylog-only — a Loki stream is chosen by each side\'s own selector, e.g. ' +
                'loki({app="frontend"}). Drop streamId.',
            );
          }
          const target: CorrelateTarget =
            resolved.sourceType === 'loki'
              ? { sourceType: 'loki', client: resolved.client, datasourceUid: resolved.source.datasourceUid }
              : { sourceType: 'graylog', client: resolved.client, streamId };

          const { events: correlated, streams: rawStreams } = await correlateLogs({
            target,
            query,
            fromMs: startsAtMs,
            toMs: resolvedEndsAtMs,
            limit: clampedLimit,
          });
          // A join query has no single replayable link, so a Loki result links
          // each stream to its own Explore view instead of one URL for the whole.
          const streams =
            resolved.sourceType === 'loki'
              ? rawStreams.map((s) => ({
                  ...s,
                  url: buildExploreUrl(resolved.grafanaUrl, {
                    datasourceUid: resolved.source.datasourceUid,
                    datasourceType: 'loki',
                    query: s.selector,
                    fromMs: startsAtMs,
                    toMs: resolvedEndsAtMs,
                  }),
                }))
              : rawStreams;

          // A stream capped at `limit` gives the join a partial view. For an
          // `unless` (anti-join) a truncated *right* side is not just lossy —
          // it inverts the meaning: a left event whose match sits past the cap
          // gets reported as "unmatched" (e.g. "this frontend request never
          // reached the backend" when it did). Refuse rather than answer
          // wrongly. Inner/`and` and `or` only under-count, so those stay a
          // surfaced `truncated` flag rather than a hard error.
          const { joinType, rightSelectors } = shape;
          const truncatedStreams = streams.filter((s) => s.truncated);
          if (joinType === 'unless' && truncatedStreams.length > 0) {
            const rightTruncated = rightSelectors.length
              ? truncatedStreams.filter((s) => rightSelectors.includes(s.selector))
              : truncatedStreams; // couldn't identify sides — treat any truncation as unsafe
            if (rightTruncated.length > 0) {
              const detail = rightTruncated
                .map((s) =>
                  s.total === undefined
                    ? `"${s.selector}" returned the full ${s.fetched}-line cap (Loki reports no total)`
                    : `"${s.selector}" fetched ${s.fetched} of ${s.total}`,
                )
                .join('; ');
              // A bigger cap is the remedy, so name the one this call ran with
              // and the next step up from it.
              const raise =
                clampedLimit < config.maxLogLines
                  ? `raise "limit" (up to MAX_LOG_LINES=${config.maxLogLines})`
                  : 'raise MAX_LOG_LINES';
              throw new Error(
                `correlate_logs: the right-hand side of an "unless" anti-join was truncated at the ` +
                  `${clampedLimit}-line cap (${detail}). A truncated right side can report left events as ` +
                  `unmatched when a match exists beyond the cap, inverting the result — refusing rather than ` +
                  `returning a wrong answer. Narrow the query or window, or ${raise}, and retry.`,
              );
            }
          }

          const url =
            resolved.sourceType === 'graylog'
              ? logSearchUrlFor(logRegistry, connectionId, {
                  query,
                  fromMs: startsAtMs,
                  toMs: resolvedEndsAtMs,
                  streamId,
                })
              : undefined;

          const result = {
            connectionId,
            sourceType: resolved.sourceType,
            correlated,
            correlatedCount: correlated.length,
            streams,
            ...(truncatedStreams.length > 0 ? { truncated: true } : {}),
            url,
            ...(warning ? { warning } : {}),
          };
          if (resolved.sourceType === 'graylog') {
            recordLogActivity(logRegistry, activityLog, {
              toolName: 'correlate_logs',
              connectionId,
              query,
              streamId,
              resultCount: correlated.length,
              url,
            });
          } else {
            activityLog?.record({
              kind: 'log',
              sourceType: 'loki',
              toolName: 'correlate_logs',
              connectionId,
              connectionName: `${resolved.source.name} (${resolved.grafanaName})`,
              query,
              resultCount: correlated.length,
            });
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        return toolErrorResult(err, config);
      }
    },
  );
}
