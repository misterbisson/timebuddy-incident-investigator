import type { DataSourceAdapter, LogEvent, StreamOptions } from '@liquescent/log-correlator-core';
import type { GrafanaClient } from '../grafana/client.js';
import type { StreamFetchStat } from './adapter.js';
import { searchLoki, type LokiLine } from './loki.js';
import { lokiJsonLabels } from './lokiJson.js';

/**
 * The labels a correlated event is joinable on: the line's stream labels, plus
 * the fields Loki's own `| json` stage would extract from a JSON line, under
 * the same names (see lokiJson.ts for the rules and the one deliberate
 * difference).
 *
 * Why the adapter does this at all: log-correlator's join grammar accepts only
 * a bare stream selector inside `loki(...)` — no pipeline stages — so a query
 * can't ask Loki for `| json` itself. Without this, a Loki event's labels would
 * be its stream labels alone, and the fields a join actually wants
 * (`request_id`, `trace_id`) are almost never stream labels: they're
 * high-cardinality, which is exactly what Loki tells you not to index. The
 * Graylog adapter gets the same effect for free, since Graylog returns every
 * indexed field.
 *
 * It mirrors `| json` rather than inventing a naming scheme, so a field is
 * named the same thing here as in a search_logs query the agent writes against
 * the same source, and has the same value: a number keeps its source text, so
 * two large integer ids never collapse into one join value.
 *
 * A JSON payload nested inside a string field (double-encoded JSON) stays a
 * string — in Loki that takes `line_format` and a second `| json`, which the
 * join grammar can't express. search_logs, which takes full LogQL, is the tool
 * for that shape.
 */
export function lokiEventLabels(line: LokiLine): Record<string, string> {
  return lokiJsonLabels(line.message, line.labels);
}

export function toLokiLogEvent(line: LokiLine): LogEvent {
  return { timestamp: line.timestamp, source: 'loki', message: line.message, labels: lokiEventLabels(line) };
}

/**
 * HistoricalGraylogAdapter's Loki counterpart: every stream is one bounded
 * search of a fixed historical window, never a live tail, regardless of the
 * `[5m]` range the join grammar requires. Each selector goes through the same
 * LogQL guard search_logs uses (see logs/loki.ts), so a join can't run a
 * query search_logs would refuse.
 */
export class HistoricalLokiAdapter implements DataSourceAdapter {
  /** Per-selector fetch stats, same role as HistoricalGraylogAdapter's. `total` is never set: Loki doesn't report one. */
  readonly fetchStats: StreamFetchStat[] = [];

  constructor(
    private readonly client: GrafanaClient,
    private readonly datasourceUid: string,
    private readonly window: { fromMs: number; toMs: number },
    private readonly limit: number,
  ) {}

  getName(): string {
    return 'loki';
  }

  validateQuery(query: string): boolean {
    return query.trim().length > 0;
  }

  async getAvailableStreams(): Promise<string[]> {
    // Loki has no enumerable stream list comparable to Graylog's; streams are
    // whatever a selector matches. list_log_sources surfaces label names instead.
    return [];
  }

  async *createStream(selector: string, _options?: StreamOptions): AsyncIterable<LogEvent> {
    // `selector` is the join parser's normalized form of what the caller wrote
    // (whitespace after a matcher's comma dropped), not their exact text. It is
    // still the string the guard in searchLoki scans and the one that runs, and
    // joinShape's right-side selectors come from the same parser.
    const trimmed = selector.trim();
    const searched = await searchLoki(this.client, {
      datasourceUid: this.datasourceUid,
      query: trimmed,
      fromMs: this.window.fromMs,
      toMs: this.window.toMs,
      limit: this.limit,
    });
    this.fetchStats.push({ selector: trimmed, fetched: searched.lines.length, truncated: searched.truncated });
    for (const line of searched.lines) {
      yield toLokiLogEvent(line);
    }
  }

  async destroy(): Promise<void> {
    // Nothing held open — each stream is one request.
  }
}
