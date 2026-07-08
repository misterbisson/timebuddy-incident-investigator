import { CorrelationEngine, type CorrelatedEvent } from '@liquescent/log-correlator-core';
import type { GraylogClient } from '../graylog/client.js';
import { HistoricalGraylogAdapter } from './adapter.js';

export interface CorrelateLogsParams {
  client: GraylogClient;
  /**
   * A log-correlator query, e.g. `graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]`.
   * The `[duration]` suffix is required by the query grammar but has no effect here — every
   * `graylog(...)` term in the query is answered from the same fixed fromMs/toMs window below,
   * not a relative lookback from now.
   */
  query: string;
  fromMs: number;
  toMs: number;
  streamId?: string;
  limit?: number;
}

/**
 * Runs a vendored log-correlator join query against one bounded, historical
 * Graylog window. Builds a fresh CorrelationEngine per call (this server is
 * stateless between tool calls) and always destroy()s it in `finally` — the
 * engine sets internal GC/processing-interval timers that would otherwise
 * leak past this call.
 */
export async function correlateLogs(params: CorrelateLogsParams): Promise<CorrelatedEvent[]> {
  const engine = new CorrelationEngine({
    // The historical fetch behind every stream in this query already
    // completed before the join starts, so there's nothing to wait for —
    // unlike a live tail, "late-arriving" events aren't a real concern here.
    lateTolerance: 2000,
  });
  const adapter = new HistoricalGraylogAdapter(params.client, {
    fromMs: params.fromMs,
    toMs: params.toMs,
    streamId: params.streamId,
    limit: params.limit,
  });
  engine.addAdapter('graylog', adapter);
  try {
    const results: CorrelatedEvent[] = [];
    for await (const correlated of engine.correlate(params.query)) {
      results.push(correlated);
    }
    return results;
  } finally {
    await engine.destroy();
  }
}
