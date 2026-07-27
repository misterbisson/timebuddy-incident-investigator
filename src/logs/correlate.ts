import type { CorrelatedEvent } from '@liquescent/log-correlator-core';
import type { GraylogClient } from '../graylog/client.js';
import { HistoricalGraylogAdapter, type StreamFetchStat } from './adapter.js';

export interface CorrelateLogsResult {
  events: CorrelatedEvent[];
  /** Per-selector fetch stats, so the caller can tell which sides were truncated at the `limit` cap. */
  streams: StreamFetchStat[];
}

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
 *
 * `@liquescent/log-correlator-core` is imported dynamically here rather than
 * at module scope: this module sits on the static import chain every server
 * startup runs (registerAll.ts -> correlateLogs.ts -> here), so a static
 * import would throw at module-evaluation time and crash the whole MCP
 * server — including every other tool — if this one optional dependency
 * were missing or failed to install. Deferring resolution to the first
 * actual correlate_logs call means a missing package only fails that one
 * tool call (surfaced as a normal tool error via toolErrorResult), not the
 * server (companion to #145).
 */
export async function correlateLogs(params: CorrelateLogsParams): Promise<CorrelateLogsResult> {
  const { CorrelationEngine } = await import('@liquescent/log-correlator-core');
  const engine = new CorrelationEngine({ defaultTimeWindow: '5m' });
  const adapter = new HistoricalGraylogAdapter(
    params.client,
    { fromMs: params.fromMs, toMs: params.toMs },
    params.streamId,
    params.limit,
  );
  engine.addAdapter('graylog', adapter);
  try {
    const events: CorrelatedEvent[] = [];
    for await (const event of engine.correlate(params.query)) {
      events.push(event);
    }
    // By the time correlate() finishes, the engine has drained every stream,
    // so adapter.fetchStats is fully populated.
    return { events, streams: adapter.fetchStats };
  } finally {
    await engine.destroy();
    await adapter.destroy();
  }
}
