import { describe, expect, it } from 'vitest';
import { correlateLogs } from '../src/logs/correlate.js';
import type { GraylogClient } from '../src/graylog/client.js';
import type { GraylogSearchResponse } from '../src/graylog/types.js';

function fakeClient(bySelector: Record<string, GraylogSearchResponse>): GraylogClient {
  return {
    searchAbsolute: async ({ query }: { query: string }) => bySelector[query] ?? { total_results: 0, fields: [], time: 0, messages: [] },
  } as unknown as GraylogClient;
}

describe('correlateLogs', () => {
  it('inner-joins two bounded historical fetches on a shared field', async () => {
    const client = fakeClient({
      'service:frontend': {
        total_results: 1,
        fields: [],
        time: 0,
        messages: [{ message: { _id: '1', message: 'frontend hit', timestamp: '2026-01-01T00:00:00.000Z', source: 'web1', request_id: 'abc123' } }],
      },
      'service:backend': {
        total_results: 1,
        fields: [],
        time: 0,
        messages: [{ message: { _id: '2', message: 'backend hit', timestamp: '2026-01-01T00:00:01.000Z', source: 'api1', request_id: 'abc123' } }],
      },
    });

    const query = `
      graylog(service:frontend)[5m]
        and on(request_id)
        graylog(service:backend)[5m]
    `;

    const results = await correlateLogs({
      client,
      query,
      fromMs: Date.parse('2026-01-01T00:00:00Z'),
      toMs: Date.parse('2026-01-01T00:10:00Z'),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.joinKey).toBe('request_id');
    expect(results[0]?.joinValue).toBe('abc123');
    expect(results[0]?.events.map((e) => e.source).sort()).toEqual(['api1', 'web1']);
  });

  it('produces no correlations when the join key never matches', async () => {
    const client = fakeClient({
      'service:frontend': {
        total_results: 1,
        fields: [],
        time: 0,
        messages: [{ message: { _id: '1', message: 'frontend hit', timestamp: '2026-01-01T00:00:00.000Z', request_id: 'abc' } }],
      },
      'service:backend': {
        total_results: 1,
        fields: [],
        time: 0,
        messages: [{ message: { _id: '2', message: 'backend hit', timestamp: '2026-01-01T00:00:01.000Z', request_id: 'different' } }],
      },
    });

    const query = `graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]`;

    const results = await correlateLogs({
      client,
      query,
      fromMs: Date.parse('2026-01-01T00:00:00Z'),
      toMs: Date.parse('2026-01-01T00:10:00Z'),
    });

    expect(results).toEqual([]);
  });
});
