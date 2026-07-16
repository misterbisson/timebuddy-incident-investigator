import { CorrelationEngine, type CorrelatedEvent } from '@liquescent/log-correlator-core';
import type { GraylogClient } from '../graylog/client.js';
import { HistoricalGraylogAdapter } from './adapter.js';

export interface CorrelateLogsParams {
  client: GraylogClient;
  /** A log-correlator join query, e.g. `graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]` — both sides hit the same connection/client; the `[5m]` window has no effect since the adapter always uses the fixed fromMs/toMs below. */
  query: string;
  fromMs: number;
  toMs: number;
  streamId?: string;
  limit: number;
}

/**
 * Runs one log-correlator join query against a fixed historical window,
 * collecting every CorrelatedEvent the engine yields. Builds a fresh
 * CorrelationEngine per call — this server is stateless across tool calls,
 * so nothing about a correlation should persist between requests — and
 * always destroy()s the engine and adapter in `finally` to clear internal
 * timers that would otherwise keep the process alive.
 */
export async function correlateLogs(params: CorrelateLogsParams): Promise<CorrelatedEvent[]> {
  const engine = new CorrelationEngine({ defaultTimeWindow: '5m' });
  const adapter = new HistoricalGraylogAdapter(
    params.client,
    { fromMs: params.fromMs, toMs: params.toMs },
    params.streamId,
    params.limit,
  );
  engine.addAdapter('graylog', adapter);
  try {
    const results: CorrelatedEvent[] = [];
    for await (const event of engine.correlate(params.query)) {
      results.push(event);
    }
    return results;
  } finally {
    await engine.destroy();
    await adapter.destroy();
  }
}
