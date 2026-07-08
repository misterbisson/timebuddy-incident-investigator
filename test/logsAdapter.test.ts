import { describe, expect, it, vi } from 'vitest';
import { HistoricalGraylogAdapter, toLabels, toLogEvent } from '../src/logs/adapter.js';
import type { GraylogClient } from '../src/graylog/client.js';
import type { GraylogMessage } from '../src/graylog/types.js';

describe('toLabels', () => {
  it('excludes the fixed fields (_id, message, timestamp, source)', () => {
    const labels = toLabels({ _id: '1', message: 'hi', timestamp: 't', source: 's', request_id: 'abc' });
    expect(labels).toEqual({ request_id: 'abc' });
  });

  it('stringifies non-string field values', () => {
    const labels = toLabels({ _id: '1', message: 'hi', timestamp: 't', level: 3 });
    expect(labels).toEqual({ level: '3' });
  });

  it('skips null/undefined fields', () => {
    const labels = toLabels({ _id: '1', message: 'hi', timestamp: 't', missing: null });
    expect(labels).toEqual({});
  });
});

describe('toLogEvent', () => {
  it('normalizes a Graylog message into the LogEvent shape, defaulting source when absent', () => {
    const m: GraylogMessage = { message: { _id: '1', message: 'hi there', timestamp: '2026-01-01T00:00:00.000Z', request_id: 'abc' } };
    expect(toLogEvent(m)).toEqual({
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'graylog',
      message: 'hi there',
      labels: { request_id: 'abc' },
    });
  });

  it('carries through an explicit source', () => {
    const m: GraylogMessage = { message: { _id: '1', message: 'hi', timestamp: 't', source: 'web1' } };
    expect(toLogEvent(m).source).toBe('web1');
  });
});

function fakeClient(response: { total_results: number; fields: string[]; time: number; messages: GraylogMessage[] }) {
  const searchAbsolute = vi.fn(async () => response);
  return { client: { searchAbsolute } as unknown as GraylogClient, searchAbsolute };
}

describe('HistoricalGraylogAdapter', () => {
  it('always searches the fixed fromMs/toMs window it was constructed with, ignoring any relative timeRange', async () => {
    const { client, searchAbsolute } = fakeClient({ total_results: 0, fields: [], time: 0, messages: [] });
    const adapter = new HistoricalGraylogAdapter(client, { fromMs: 1000, toMs: 2000, streamId: 'stream1', limit: 50 });

    const events = [];
    for await (const e of adapter.createStream('service:frontend')) events.push(e);

    expect(events).toEqual([]);
    expect(searchAbsolute).toHaveBeenCalledWith({ query: 'service:frontend', fromMs: 1000, toMs: 2000, streamId: 'stream1', limit: 50 });
  });

  it('yields normalized LogEvents for every returned message', async () => {
    const { client } = fakeClient({
      total_results: 1,
      fields: [],
      time: 0,
      messages: [{ message: { _id: '1', message: 'frontend hit', timestamp: '2026-01-01T00:00:00.000Z', request_id: 'abc123' } }],
    });
    const adapter = new HistoricalGraylogAdapter(client, { fromMs: 1000, toMs: 2000 });

    const events = [];
    for await (const e of adapter.createStream('service:frontend')) events.push(e);

    expect(events).toEqual([{ timestamp: '2026-01-01T00:00:00.000Z', source: 'graylog', message: 'frontend hit', labels: { request_id: 'abc123' } }]);
  });

  it('reports itself as the "graylog" adapter and always validates queries (parsing is the query-parser\'s job)', () => {
    const { client } = fakeClient({ total_results: 0, fields: [], time: 0, messages: [] });
    const adapter = new HistoricalGraylogAdapter(client, { fromMs: 0, toMs: 1 });
    expect(adapter.getName()).toBe('graylog');
    expect(adapter.validateQuery()).toBe(true);
  });
});
