import { describe, expect, it } from 'vitest';
import { lokiEventLabels } from '../src/logs/lokiAdapter.js';
import { correlateLogs } from '../src/logs/correlate.js';
import { fakeLokiClient } from './lokiFixtures.js';

const T0 = Date.parse('2026-03-01T10:00:00Z');
const line = (message: string, labels: Record<string, string> = { app: 'checkout' }) => ({
  timestamp: '2026-03-01T10:00:00.000Z',
  message,
  labels,
});

describe('lokiEventLabels — the fields | json would extract', () => {
  it('adds top-level JSON fields to the stream labels', () => {
    expect(lokiEventLabels(line('{"request_id":"r1","status":500,"ok":false}'))).toEqual({
      app: 'checkout',
      request_id: 'r1',
      status: '500',
      ok: 'false',
    });
  });

  it('flattens nested objects with "_" and sanitizes key characters, like Loki does', () => {
    expect(lokiEventLabels(line('{"error":{"code":"E42"},"http.method":"GET","2xx":1}'))).toEqual({
      app: 'checkout',
      error_code: 'E42',
      http_method: 'GET',
      _2xx: '1',
    });
  });

  it('suffixes a key that collides with a stream label with _extracted rather than overwriting it', () => {
    expect(lokiEventLabels(line('{"app":"from-the-line"}'))).toEqual({ app: 'checkout', app_extracted: 'from-the-line' });
  });

  it('skips arrays and nulls', () => {
    expect(lokiEventLabels(line('{"tags":["a","b"],"user":null,"k":"v"}'))).toEqual({ app: 'checkout', k: 'v' });
  });

  it('leaves a non-JSON line with its stream labels only', () => {
    expect(lokiEventLabels(line('GET /cart 500 request_id=r1'))).toEqual({ app: 'checkout' });
    expect(lokiEventLabels(line('["not","an","object"]'))).toEqual({ app: 'checkout' });
  });

  it('does not reach into a JSON payload double-encoded inside a string field', () => {
    // In Loki that takes line_format + a second | json, which the join grammar
    // can't express — search_logs is the tool for that shape.
    expect(lokiEventLabels(line('{"payload":"{\\"request_id\\":\\"r1\\"}"}'))).toEqual({ app: 'checkout', payload: '{"request_id":"r1"}' });
  });
});

describe('correlateLogs against a Loki source', () => {
  const front = [
    { t: T0, line: '{"request_id":"r1","path":"/cart"}', labels: { app: 'frontend' } },
    { t: T0 + 1000, line: '{"request_id":"r2","path":"/pay"}', labels: { app: 'frontend' } },
  ];
  const back = [{ t: T0 + 500, line: '{"request_id":"r1","status":500}', labels: { app: 'backend' } }];

  it('joins on a field extracted from JSON lines, through the real engine', async () => {
    const { client, queryDs } = fakeLokiClient({ linesByExpr: { '{app="frontend"}': front, '{app="backend"}': back } });
    const { events, streams } = await correlateLogs({
      target: { sourceType: 'loki', client, datasourceUid: 'logs1' },
      query: 'loki({app="frontend"})[5m] and on(request_id) loki({app="backend"})[5m]',
      fromMs: T0,
      toMs: T0 + 60_000,
      limit: 100,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.joinValue).toBe('r1');
    expect(events[0]?.metadata.completeness).toBe('complete');
    expect(streams).toEqual([
      { selector: '{app="frontend"}', fetched: 2, truncated: false },
      { selector: '{app="backend"}', fetched: 1, truncated: false },
    ]);
    // Every side ran against the fixed window, not a live tail.
    for (const [req] of queryDs.mock.calls) {
      expect([req.from, req.to]).toEqual([String(T0), String(T0 + 60_000)]);
    }
  });

  it('answers an anti-join ("unless") from extracted fields', async () => {
    const { client } = fakeLokiClient({ linesByExpr: { '{app="frontend"}': front, '{app="backend"}': back } });
    const { events } = await correlateLogs({
      target: { sourceType: 'loki', client, datasourceUid: 'logs1' },
      query: 'loki({app="frontend"})[5m] unless on(request_id) loki({app="backend"})[5m]',
      fromMs: T0,
      toMs: T0 + 60_000,
      limit: 100,
    });
    expect(events.map((e) => e.joinValue)).toEqual(['r2']);
  });

  it('marks a stream that hit the cap as truncated, with no total', async () => {
    const { client } = fakeLokiClient({ linesByExpr: { '{app="frontend"}': front, '{app="backend"}': back } });
    const { streams } = await correlateLogs({
      target: { sourceType: 'loki', client, datasourceUid: 'logs1' },
      query: 'loki({app="frontend"})[5m] and on(request_id) loki({app="backend"})[5m]',
      fromMs: T0,
      toMs: T0 + 60_000,
      limit: 1,
    });
    expect(streams[0]).toEqual({ selector: '{app="frontend"}', fetched: 1, truncated: true });
  });
});
