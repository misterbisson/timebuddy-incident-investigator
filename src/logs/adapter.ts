import type { DataSourceAdapter, LogEvent, StreamOptions } from '@liquescent/log-correlator-core';
import type { GraylogClient } from '../graylog/client.js';
import type { GraylogMessageWrapper } from '../graylog/types.js';

const FIXED_FIELDS = new Set(['_id', 'message', 'timestamp', 'source']);

/**
 * Turns every non-fixed field on a Graylog message into a join-able string
 * label — log-correlator's join grammar (`and on(request_id)`, `unless`,
 * `group_left()`) matches on `LogEvent.labels`, so anything Graylog indexed
 * beyond the fixed message/timestamp/source fields needs to show up here to
 * be joinable. Skips null/undefined (nothing meaningful to join on) and
 * stringifies non-string values (numbers, booleans) since labels are always
 * strings.
 */
export function toLabels(message: GraylogMessageWrapper['message']): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(message)) {
    if (FIXED_FIELDS.has(key)) continue;
    if (value === null || value === undefined) continue;
    labels[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return labels;
}

/**
 * Per-selector record of how much of a Graylog search actually came back vs.
 * how much matched. `truncated` is the one that matters downstream: the
 * `limit` cap (default maxLogLines) silently drops everything past N, and a
 * join computed over a truncated stream can under-count (inner join) or, worse,
 * invert (anti-join) — see correlate_logs' handling of a truncated `unless`
 * right side. Surfaced so nothing derives a confident answer from partial data.
 */
export interface StreamFetchStat {
  selector: string;
  fetched: number;
  total: number;
  truncated: boolean;
}

export function toLogEvent(wrapper: GraylogMessageWrapper): LogEvent {
  const { message } = wrapper;
  return {
    timestamp: message.timestamp,
    source: message.source ?? 'graylog',
    message: message.message,
    labels: toLabels(message),
  };
}

/**
 * A DataSourceAdapter for log-correlator's CorrelationEngine, backed by one
 * bounded historical Graylog search instead of the engine's normal live-tail
 * model. log-correlator's own Graylog/Loki adapters are hardcoded to derive
 * `from = now - window, to = now` on every createStream() call — built
 * exclusively for tailing, incompatible with reviewing a fixed, possibly
 * days-old incident window. This adapter ignores the `timeRange` the engine
 * derives from a query's `[5m]` grammar entirely and always re-runs the
 * search against the fixed window supplied at construction — confirmed
 * (by reading their source) that the join engine itself has no live-tail
 * assumptions baked in, only their bundled adapters do.
 */
export class HistoricalGraylogAdapter implements DataSourceAdapter {
  /**
   * Per-selector fetch stats, appended once per createStream() call. Read by
   * correlateLogs() after the engine has drained every stream, so it can tell
   * the caller which sides were truncated at the `limit` cap.
   */
  readonly fetchStats: StreamFetchStat[] = [];

  constructor(
    private readonly client: GraylogClient,
    private readonly window: { fromMs: number; toMs: number },
    private readonly streamId: string | undefined,
    private readonly limit: number,
  ) {}

  getName(): string {
    return 'graylog';
  }

  validateQuery(query: string): boolean {
    return query.trim().length > 0;
  }

  async getAvailableStreams(): Promise<string[]> {
    const streams = await this.client.listStreams();
    return streams.map((s) => s.id);
  }

  async *createStream(selector: string, _options?: StreamOptions): AsyncIterable<LogEvent> {
    const trimmed = selector.trim();
    const response = await this.client.searchAbsolute({
      query: trimmed.length > 0 ? trimmed : '*',
      fromMs: this.window.fromMs,
      toMs: this.window.toMs,
      streamId: this.streamId,
      limit: this.limit,
    });
    // total_results is Graylog's count of everything that matched the window,
    // independent of the `limit` we capped the fetch at — so total > fetched
    // means the join below is running on a truncated view of this stream.
    const fetched = response.messages.length;
    const total = response.total_results ?? fetched;
    this.fetchStats.push({ selector: trimmed, fetched, total, truncated: total > fetched });
    for (const wrapper of response.messages) {
      yield toLogEvent(wrapper);
    }
  }

  async destroy(): Promise<void> {
    // Nothing to release — each search is a one-shot HTTP request, not a
    // held connection/subscription like a real tailing adapter would have.
  }
}
