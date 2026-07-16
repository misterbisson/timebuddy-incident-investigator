import { describe, expect, it } from 'vitest';
import { registerCorrelateLogs } from '../src/tools/correlateLogs.js';
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

describe('correlate_logs tool', () => {
  it('runs a join query end to end and returns correlated/correlatedCount/url', async () => {
    const { client } = fakeGraylogClient({
      messagesBySelector: {
        'service:frontend': [{ message: { message: 'front', timestamp: '2026-01-01T00:00:00Z', source: 'frontend-host', request_id: 'r1' } }],
        'service:backend': [{ message: { message: 'back', timestamp: '2026-01-01T00:00:01Z', source: 'backend-host', request_id: 'r1' } }],
      },
    });
    const { server, call } = fakeServer();
    registerCorrelateLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config() } as never);

    const result = (await call('correlate_logs', {
      query: 'graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]',
      startsAtMs: 0,
      endsAtMs: 1,
    })) as { content: Array<{ text: string }> };

    const body = JSON.parse(result.content[0]!.text);
    expect(body.connectionId).toBe('log1');
    expect(body.correlatedCount).toBe(1);
    expect(body.correlated).toHaveLength(1);
    expect(body.correlated[0].joinValue).toBe('r1');
    expect(body.url).toContain('https://graylog.example.com/search');
  });

  it('returns an empty correlated array (not an error) when nothing matches', async () => {
    const { client } = fakeGraylogClient({
      messagesBySelector: {
        'service:frontend': [{ message: { message: 'front', timestamp: '2026-01-01T00:00:00Z', source: 'frontend-host', request_id: 'r1' } }],
        'service:backend': [],
      },
    });
    const { server, call } = fakeServer();
    registerCorrelateLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config() } as never);

    const result = (await call('correlate_logs', {
      query: 'graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]',
      startsAtMs: 0,
      endsAtMs: 1,
    })) as { content: Array<{ text: string }> };

    const body = JSON.parse(result.content[0]!.text);
    expect(body.correlatedCount).toBe(0);
    expect(body.correlated).toEqual([]);
  });

  it('returns an error result for a malformed join query rather than throwing past the tool boundary', async () => {
    const { client } = fakeGraylogClient({ messages: [] });
    const { server, call } = fakeServer();
    registerCorrelateLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config() } as never);

    const result = (await call('correlate_logs', {
      query: 'this is not a valid query',
      startsAtMs: 0,
      endsAtMs: 1,
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
  });

  it('clamps limit to maxLogLines before running the query', async () => {
    const { client, searchAbsolute } = fakeGraylogClient({
      messagesBySelector: { 'service:frontend': [], 'service:backend': [] },
    });
    const { server, call } = fakeServer();
    registerCorrelateLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config({ maxLogLines: 50 }) } as never);

    await call('correlate_logs', {
      query: 'graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]',
      startsAtMs: 0,
      endsAtMs: 1,
      limit: 9999,
    });
    expect(searchAbsolute).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });
});
