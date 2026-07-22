import { describe, expect, it, vi } from 'vitest';
import { registerSearchLogs } from '../src/tools/searchLogs.js';
import type { Config, LogConnection } from '../src/config.js';
import { GraylogApiError } from '../src/graylog/client.js';
import type { GraylogClient } from '../src/graylog/client.js';
import { fakeGraylogClient, fakeLogRegistry, fakeServer } from './toolTestHelpers.js';
import { createActivityLog } from '../src/activity/activityLog.js';

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

  // Regression for #62/#88: a GraylogApiError echoes the offending query — with
  // customer identifiers already substituted in — back in both the URL-encoded
  // path and the response body. The tool's catch must route through
  // toolErrorResult so redactionPatterns mask them, exactly like the success path.
  it('redacts configured identifiers from a GraylogApiError before returning it to the model', async () => {
    const path = '/api/search/universal/absolute?query=customer%3Aacct-778899&from=x&to=y';
    const searchAbsolute = vi.fn(async () => {
      throw new GraylogApiError(
        `Graylog GET ${path} failed: 400 {"message":"cannot parse query customer:acct-778899"}`,
        400,
        path,
      );
    });
    const client = { searchAbsolute, listStreams: vi.fn() } as unknown as GraylogClient;
    const { server, call } = fakeServer();
    registerSearchLogs(server, {
      logRegistry: fakeLogRegistry(connections, client),
      config: config({ redactionPatterns: [/acct-\d+/i] }),
    } as never);

    const result = (await call('search_logs', { query: 'customer:acct-778899', startsAtMs: 0, endsAtMs: 1 })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain('acct-778899');
    expect(result.content[0]!.text).toContain('[REDACTED]');
  });

  it('rejects a window wider than MAX_LOOKBACK_HOURS before hitting Graylog', async () => {
    const { client, searchAbsolute } = fakeGraylogClient({ messages: [] });
    const { server, call } = fakeServer();
    registerSearchLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config({ maxLookbackHours: 24 }) } as never);

    const result = (await call('search_logs', {
      query: '*',
      startsAtMs: 0,
      endsAtMs: 48 * 3_600_000, // 48h > 24h cap
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/MAX_LOOKBACK_HOURS/);
    expect(searchAbsolute).not.toHaveBeenCalled();
  });

  it('rejects a reversed window (endsAtMs <= startsAtMs) before hitting Graylog', async () => {
    const { client, searchAbsolute } = fakeGraylogClient({ messages: [] });
    const { server, call } = fakeServer();
    registerSearchLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config() } as never);

    const result = (await call('search_logs', { query: '*', startsAtMs: 2000, endsAtMs: 1000 })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/non-positive duration/);
    expect(searchAbsolute).not.toHaveBeenCalled();
  });

  it('records a log-kind activity entry with the resolved connection and default stream name (#116)', async () => {
    const streamed: LogConnection[] = [
      { id: 'log1', name: 'Prod Graylog', sourceType: 'graylog', url: 'https://graylog.example.com', authType: 'token', token: 'x', streamId: 'stream-default', streamName: 'All prod' },
    ];
    const { client } = fakeGraylogClient({ messages: [{ message: { message: 'boom' } }] });
    const activityLog = createActivityLog();
    const { server, call } = fakeServer();
    registerSearchLogs(server, {
      logRegistry: fakeLogRegistry(streamed, client),
      config: config({ logConnections: streamed }),
      activityLog,
    } as never);

    await call('search_logs', { query: 'host:web-03', startsAtMs: 1000, endsAtMs: 2000 });

    const [entry] = activityLog.list();
    expect(entry).toMatchObject({
      kind: 'log',
      toolName: 'search_logs',
      connectionId: 'log1',
      connectionName: 'Prod Graylog',
      query: 'host:web-03',
      streamName: 'All prod',
      resultCount: 1,
    });
    expect(entry!.url).toContain('https://graylog.example.com');
  });

  it('does not attach a stream name when an explicit streamId differs from the connection default (#116)', async () => {
    const streamed: LogConnection[] = [
      { id: 'log1', name: 'Prod Graylog', sourceType: 'graylog', url: 'https://graylog.example.com', authType: 'token', token: 'x', streamId: 'stream-default', streamName: 'All prod' },
    ];
    const { client } = fakeGraylogClient({ messages: [] });
    const activityLog = createActivityLog();
    const { server, call } = fakeServer();
    registerSearchLogs(server, {
      logRegistry: fakeLogRegistry(streamed, client),
      config: config({ logConnections: streamed }),
      activityLog,
    } as never);

    await call('search_logs', { query: '*', startsAtMs: 0, endsAtMs: 1, streamId: 'other-stream' });

    const [entry] = activityLog.list();
    expect(entry).toMatchObject({ kind: 'log', streamId: 'other-stream' });
    expect((entry as { streamName?: string }).streamName).toBeUndefined();
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
