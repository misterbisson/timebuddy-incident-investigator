import { describe, expect, it, vi } from 'vitest';
import { correlateLogs } from '../src/logs/correlate.js';
import type { GraylogClient } from '../src/graylog/client.js';
import type { GraylogMessageWrapper } from '../src/graylog/types.js';

/**
 * Fake client whose searchAbsolute returns a fixed message set per selector
 * string (HistoricalGraylogAdapter passes the query-parser's per-stream
 * selector, e.g. "service:frontend", straight through as `query`) — enough
 * to drive log-correlator's real CorrelationEngine/StreamJoiner/
 * MultiStreamJoiner against deterministic fixtures, with no live Graylog.
 */
function fakeClient(messagesBySelector: Record<string, GraylogMessageWrapper[]>): GraylogClient {
  return {
    searchAbsolute: vi.fn(async ({ query }: { query: string }) => ({
      messages: messagesBySelector[query] ?? [],
      total_results: (messagesBySelector[query] ?? []).length,
    })),
    listStreams: vi.fn(async () => []),
  } as unknown as GraylogClient;
}

function msg(source: string, timestamp: string, requestId: string, message = `${source} ${requestId}`): GraylogMessageWrapper {
  return { message: { message, timestamp, source, request_id: requestId } };
}

describe('correlateLogs', () => {
  it('inner join ("and"): returns only join keys present on both sides, marked complete', async () => {
    const client = fakeClient({
      'service:frontend': [msg('frontend-host', '2026-01-01T00:00:00Z', 'r1'), msg('frontend-host', '2026-01-01T00:00:01Z', 'r2')],
      'service:backend': [msg('backend-host', '2026-01-01T00:00:02Z', 'r1')],
    });

    const results = await correlateLogs({
      client,
      query: 'graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]',
      fromMs: 0,
      toMs: 1,
      limit: 500,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.joinValue).toBe('r1');
    expect(results[0]?.metadata.completeness).toBe('complete');
    expect(results[0]?.metadata.matchedStreams.sort()).toEqual(['backend-host', 'frontend-host']);
    expect(results[0]?.events).toHaveLength(2);
  });

  it('inner join ("and"): returns nothing when no join key matches on both sides', async () => {
    const client = fakeClient({
      'service:frontend': [msg('frontend-host', '2026-01-01T00:00:00Z', 'r1')],
      'service:backend': [msg('backend-host', '2026-01-01T00:00:00Z', 'r-unrelated')],
    });

    const results = await correlateLogs({
      client,
      query: 'graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]',
      fromMs: 0,
      toMs: 1,
      limit: 500,
    });

    expect(results).toEqual([]);
  });

  it('anti-join ("unless"): returns left-side events with no match on the right, marked partial', async () => {
    const client = fakeClient({
      'service:frontend': [msg('frontend-host', '2026-01-01T00:00:00Z', 'r1'), msg('frontend-host', '2026-01-01T00:00:01Z', 'r2')],
      'service:backend': [msg('backend-host', '2026-01-01T00:00:02Z', 'r1')],
    });

    const results = await correlateLogs({
      client,
      query: 'graylog(service:frontend)[5m] unless on(request_id) graylog(service:backend)[5m]',
      fromMs: 0,
      toMs: 1,
      limit: 500,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.joinValue).toBe('r2');
    expect(results[0]?.metadata.completeness).toBe('partial');
    expect(results[0]?.metadata.matchedStreams).toEqual(['frontend-host']);
  });

  it('left join ("or"): includes every left-side key, complete when matched and partial when not', async () => {
    const client = fakeClient({
      'service:frontend': [msg('frontend-host', '2026-01-01T00:00:00Z', 'r1'), msg('frontend-host', '2026-01-01T00:00:01Z', 'r2')],
      'service:backend': [msg('backend-host', '2026-01-01T00:00:02Z', 'r1')],
    });

    const results = await correlateLogs({
      client,
      query: 'graylog(service:frontend)[5m] or on(request_id) graylog(service:backend)[5m]',
      fromMs: 0,
      toMs: 1,
      limit: 500,
    });

    const byJoinValue = Object.fromEntries(results.map((r) => [r.joinValue, r]));
    expect(byJoinValue.r1?.metadata.completeness).toBe('complete');
    expect(byJoinValue.r2?.metadata.completeness).toBe('partial');
  });

  it('multi-way join: a 3-stream "and" query only correlates keys present on every stream', async () => {
    const client = fakeClient({
      'service:frontend': [msg('frontend-host', '2026-01-01T00:00:00Z', 'r1'), msg('frontend-host', '2026-01-01T00:00:01Z', 'r2')],
      'service:backend': [msg('backend-host', '2026-01-01T00:00:02Z', 'r1'), msg('backend-host', '2026-01-01T00:00:03Z', 'r2')],
      'service:db': [msg('db-host', '2026-01-01T00:00:04Z', 'r1')],
    });

    const results = await correlateLogs({
      client,
      query:
        'graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m] and on(request_id) graylog(service:db)[5m]',
      fromMs: 0,
      toMs: 1,
      limit: 500,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.joinValue).toBe('r1');
    // Unlike the 2-stream StreamJoiner (which labels matchedStreams by each
    // event's real `source`), MultiStreamJoiner labels them by the query's
    // adapter/source name — 'graylog' for every stream here, since all three
    // selectors share the one registered adapter. totalStreams/completeness
    // and each event's own `source` are what actually distinguish the streams.
    expect(results[0]?.metadata.matchedStreams).toEqual(['graylog', 'graylog', 'graylog']);
    expect(results[0]?.metadata.totalStreams).toBe(3);
    expect(results[0]?.metadata.completeness).toBe('complete');
    expect(results[0]?.events.map((e) => e.source).sort()).toEqual(['backend-host', 'db-host', 'frontend-host']);
  });

  it('destroys the engine and adapter even when the query throws (malformed query)', async () => {
    const client = fakeClient({});
    await expect(
      correlateLogs({ client, query: 'not a valid query', fromMs: 0, toMs: 1, limit: 500 }),
    ).rejects.toThrow();
  });
});
