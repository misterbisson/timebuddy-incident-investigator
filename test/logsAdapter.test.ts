import { describe, expect, it, vi } from 'vitest';
import { HistoricalGraylogAdapter, toLabels, toLogEvent } from '../src/logs/adapter.js';
import type { GraylogClient } from '../src/graylog/client.js';
import type { GraylogMessageWrapper } from '../src/graylog/types.js';

describe('toLabels', () => {
  it('excludes the fixed fields (_id, message, timestamp, source)', () => {
    const labels = toLabels({ _id: '1', message: 'hi', timestamp: 't', source: 'host1', request_id: 'r1' });
    expect(labels).toEqual({ request_id: 'r1' });
  });

  it('stringifies non-string field values', () => {
    const labels = toLabels({ message: 'hi', timestamp: 't', status: 500, ok: false });
    expect(labels).toEqual({ status: '500', ok: 'false' });
  });

  it('skips null/undefined field values', () => {
    const labels = toLabels({ message: 'hi', timestamp: 't', missing: null, alsoMissing: undefined, present: 'x' });
    expect(labels).toEqual({ present: 'x' });
  });
});

describe('toLogEvent', () => {
  it('builds a LogEvent from a Graylog message wrapper', () => {
    const wrapper: GraylogMessageWrapper = {
      message: { _id: '1', message: 'boom', timestamp: '2026-01-01T00:00:00Z', source: 'host1', request_id: 'r1' },
    };
    expect(toLogEvent(wrapper)).toEqual({
      timestamp: '2026-01-01T00:00:00Z',
      source: 'host1',
      message: 'boom',
      labels: { request_id: 'r1' },
    });
  });

  it('defaults source to "graylog" when Graylog didn\'t index one for this message', () => {
    const wrapper: GraylogMessageWrapper = { message: { message: 'boom', timestamp: '2026-01-01T00:00:00Z' } };
    expect(toLogEvent(wrapper).source).toBe('graylog');
  });
});

function fakeClient(response: { messages: GraylogMessageWrapper[] }): { client: GraylogClient; searchAbsolute: ReturnType<typeof vi.fn> } {
  const searchAbsolute = vi.fn(async () => ({ messages: response.messages, total_results: response.messages.length }));
  const client = { searchAbsolute, listStreams: vi.fn(async () => []) } as unknown as GraylogClient;
  return { client, searchAbsolute };
}

describe('HistoricalGraylogAdapter', () => {
  it('getName() reports "graylog", matching the source name used in a correlate_logs query', () => {
    const { client } = fakeClient({ messages: [] });
    const adapter = new HistoricalGraylogAdapter(client, { fromMs: 0, toMs: 1 }, undefined, 500);
    expect(adapter.getName()).toBe('graylog');
  });

  it('createStream() yields one LogEvent per returned message', async () => {
    const { client } = fakeClient({
      messages: [
        { message: { message: 'first', timestamp: '2026-01-01T00:00:00Z', source: 'h1' } },
        { message: { message: 'second', timestamp: '2026-01-01T00:00:01Z', source: 'h1' } },
      ],
    });
    const adapter = new HistoricalGraylogAdapter(client, { fromMs: 0, toMs: 1 }, undefined, 500);
    const events = [];
    for await (const event of adapter.createStream('service:frontend')) events.push(event);
    expect(events.map((e) => e.message)).toEqual(['first', 'second']);
  });

  it('ignores the engine-derived timeRange option and always searches the fixed constructor window', async () => {
    const { client, searchAbsolute } = fakeClient({ messages: [] });
    const adapter = new HistoricalGraylogAdapter(client, { fromMs: 111, toMs: 222 }, undefined, 500);
    const iterator = adapter.createStream('service:frontend', { timeRange: '5m' });
    for await (const _ of iterator) {
      // drain
    }
    expect(searchAbsolute).toHaveBeenCalledWith(
      expect.objectContaining({ fromMs: 111, toMs: 222, query: 'service:frontend' }),
    );
  });

  it('passes the constructor streamId and limit through to every search', async () => {
    const { client, searchAbsolute } = fakeClient({ messages: [] });
    const adapter = new HistoricalGraylogAdapter(client, { fromMs: 0, toMs: 1 }, 'stream-1', 42);
    for await (const _ of adapter.createStream('*')) {
      // drain
    }
    expect(searchAbsolute).toHaveBeenCalledWith(expect.objectContaining({ streamId: 'stream-1', limit: 42 }));
  });

  it('validateQuery() rejects an empty/whitespace-only selector', () => {
    const { client } = fakeClient({ messages: [] });
    const adapter = new HistoricalGraylogAdapter(client, { fromMs: 0, toMs: 1 }, undefined, 500);
    expect(adapter.validateQuery('  ')).toBe(false);
    expect(adapter.validateQuery('service:frontend')).toBe(true);
  });

  it('destroy() resolves without needing any teardown (each search is one-shot, no held connection)', async () => {
    const { client } = fakeClient({ messages: [] });
    const adapter = new HistoricalGraylogAdapter(client, { fromMs: 0, toMs: 1 }, undefined, 500);
    await expect(adapter.destroy()).resolves.toBeUndefined();
  });
});
