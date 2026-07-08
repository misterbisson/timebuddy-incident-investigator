import type { DataSourceAdapter, LogEvent } from '@liquescent/log-correlator-core';
import type { GraylogClient } from '../graylog/client.js';
import type { GraylogMessage } from '../graylog/types.js';

const FIXED_FIELDS = new Set(['_id', 'message', 'timestamp', 'source']);

/** Every other indexed field on the message becomes a label — join keys (request_id, trace_id, ...) are just labels here, since StreamJoiner checks `event.labels[key]` before `event.joinKeys`. Exported for direct testing. */
export function toLabels(message: GraylogMessage['message']): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(message)) {
    if (FIXED_FIELDS.has(key) || value === undefined || value === null) continue;
    labels[key] = String(value);
  }
  return labels;
}

/** Normalizes one Graylog message into log-correlator's LogEvent shape. Exported for direct testing. */
export function toLogEvent(m: GraylogMessage): LogEvent {
  const { message } = m;
  return {
    timestamp: message.timestamp,
    source: message.source ?? 'graylog',
    message: message.message,
    labels: toLabels(message),
  };
}

/**
 * Wraps a single bounded, historical Graylog search as a log-correlator
 * DataSourceAdapter. Deliberately ignores the `options.timeRange` the engine
 * would normally derive from a query's `[5m]`-style range-vector suffix —
 * this adapter always searches the fixed fromMs/toMs window it was
 * constructed with, which is what makes correlate_logs a bounded, one-shot,
 * historical operation instead of the package's own live-tail adapters.
 * Constructed fresh per tool call (see logs/correlate.ts), not shared/reused.
 */
export class HistoricalGraylogAdapter implements DataSourceAdapter {
  constructor(
    private readonly client: GraylogClient,
    private readonly window: { fromMs: number; toMs: number; streamId?: string; limit?: number },
  ) {}

  getName(): string {
    return 'graylog';
  }

  validateQuery(): boolean {
    return true;
  }

  async *createStream(query: string): AsyncIterable<LogEvent> {
    const response = await this.client.searchAbsolute({
      query,
      fromMs: this.window.fromMs,
      toMs: this.window.toMs,
      streamId: this.window.streamId,
      limit: this.window.limit,
    });
    for (const m of response.messages) {
      yield toLogEvent(m);
    }
  }

  async destroy(): Promise<void> {
    // No connection/timer to tear down — one bounded fetch per createStream() call.
  }
}
