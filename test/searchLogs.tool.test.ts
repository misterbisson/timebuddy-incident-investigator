import { describe, expect, it } from 'vitest';
import { registerSearchLogs } from '../src/tools/searchLogs.js';
import type { Config, LogConnection } from '../src/config.js';
import { fakeGraylogClient, fakeLogRegistry, fakeServer } from './toolTestHelpers.js';

const connections: LogConnection[] = [
  { id: 'log1', name: 'log1', sourceType: 'graylog', url: 'https://graylog.example.com', authType: 'token', token: 'x' },
];

function config(overrides: Partial<Config> = {}): Config {
  return {
    connections: [],
    logConnections: connections,
    tlsVerify: true,
    requestTimeoutMs: 1000,
    screenshotTimeoutMs: 45000,
    maxConcurrency: 4,
    maxLookbackHours: 720,
    maxDataPoints: 2000,
    maxLogLines: 500,
    redactionPatterns: [],
    dataDir: '.data',
    webhookPort: 4318,
    ...overrides,
  };
}

describe('search_logs tool', () => {
  it('returns messages, totalResults, and a clickable Graylog URL', async () => {
    const { client } = fakeGraylogClient({
      messages: [{ message: { message: 'boom', timestamp: '2026-01-01T00:00:00Z', source: 'host1' } }],
    });
    const { server, call } = fakeServer();
    registerSearchLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config() } as never);

    const result = (await call('search_logs', {
      query: 'service:frontend',
      startsAtMs: 1000,
      endsAtMs: 2000,
    })) as { content: Array<{ text: string }> };

    const body = JSON.parse(result.content[0]!.text);
    expect(body.connectionId).toBe('log1');
    expect(body.totalResults).toBe(1);
    expect(body.messages).toEqual([{ message: 'boom', timestamp: '2026-01-01T00:00:00Z', source: 'host1' }]);
    expect(body.url).toContain('https://graylog.example.com/search');
    expect(body.warning).toBeUndefined();
  });

  it('passes the requested limit through to the client, clamped to maxLogLines', async () => {
    const { client, searchAbsolute } = fakeGraylogClient({ messages: [] });
    const { server, call } = fakeServer();
    registerSearchLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config({ maxLogLines: 100 }) } as never);

    await call('search_logs', { query: '*', startsAtMs: 0, endsAtMs: 1, limit: 9999 });
    expect(searchAbsolute).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));

    await call('search_logs', { query: '*', startsAtMs: 0, endsAtMs: 1, limit: 10 });
    expect(searchAbsolute).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
  });

  it('passes streamId through to the client and the URL', async () => {
    const { client, searchAbsolute } = fakeGraylogClient({ messages: [] });
    const { server, call } = fakeServer();
    registerSearchLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config() } as never);

    const result = (await call('search_logs', {
      query: '*',
      startsAtMs: 0,
      endsAtMs: 1,
      streamId: 'stream-1',
    })) as { content: Array<{ text: string }> };

    expect(searchAbsolute).toHaveBeenCalledWith(expect.objectContaining({ streamId: 'stream-1' }));
    const body = JSON.parse(result.content[0]!.text);
    expect(body.url).toContain('/streams/stream-1/search');
  });

  it('warns (without failing) when endsAtMs is omitted and the window balloons past a day', async () => {
    const { client } = fakeGraylogClient({ messages: [] });
    const { server, call } = fakeServer();
    registerSearchLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config() } as never);

    const result = (await call('search_logs', {
      query: '*',
      startsAtMs: Date.now() - 5 * 24 * 3_600_000,
    })) as { content: Array<{ text: string }> };

    const body = JSON.parse(result.content[0]!.text);
    expect(body.warning).toMatch(/defaulted to now/);
  });

  it('returns an error result (not a thrown exception) when no log connection is configured', async () => {
    const { client } = fakeGraylogClient({ messages: [] });
    const { server, call } = fakeServer();
    registerSearchLogs(server, { logRegistry: fakeLogRegistry([], client), config: config({ logConnections: [] }) } as never);

    const result = (await call('search_logs', { query: '*', startsAtMs: 0, endsAtMs: 1 })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/No Graylog connections configured/);
  });
});
