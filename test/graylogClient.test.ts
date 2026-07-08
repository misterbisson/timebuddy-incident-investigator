import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraylogClient } from '../src/graylog/client.js';
import type { Config, LogConnection } from '../src/config.js';

const config: Config = {
  connections: [],
  logConnections: [],
  tlsVerify: true,
  requestTimeoutMs: 1000,
  maxConcurrency: 4,
  maxLookbackHours: 720,
  maxDataPoints: 2000,
  maxLogLines: 500,
  redactionPatterns: [],
  dataDir: '.data',
  webhookPort: 4318,
};

const bearerConn: LogConnection = {
  id: 'a',
  name: 'a',
  sourceType: 'graylog',
  url: 'https://graylog.example.com',
  authType: 'bearer',
  token: 'my-token',
};

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body, text: async () => '' } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GraylogClient.searchAbsolute', () => {
  it('queries the absolute-range endpoint with ISO8601 from/to and a bearer auth header', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ total_results: 0, fields: [], time: 0, messages: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GraylogClient(bearerConn, config);
    await client.searchAbsolute({ query: 'service:frontend', fromMs: Date.parse('2026-01-01T00:00:00Z'), toMs: Date.parse('2026-01-01T01:00:00Z') });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe('/api/search/universal/absolute');
    expect(parsed.searchParams.get('query')).toBe('service:frontend');
    expect(parsed.searchParams.get('from')).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.searchParams.get('to')).toBe('2026-01-01T01:00:00.000Z');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer my-token' });
  });

  it('adds a streams filter when streamId is given', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ total_results: 0, fields: [], time: 0, messages: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GraylogClient(bearerConn, config);
    await client.searchAbsolute({ query: 'x', fromMs: 0, toMs: 1, streamId: 'stream1' });

    const [url] = fetchMock.mock.calls[0]!;
    expect(new URL(url as string).searchParams.get('filter')).toBe('streams:stream1');
  });

  it('falls back to the connection\'s configured streamId when none is passed per-call', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ total_results: 0, fields: [], time: 0, messages: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GraylogClient({ ...bearerConn, streamId: 'default-stream' }, config);
    await client.searchAbsolute({ query: 'x', fromMs: 0, toMs: 1 });

    const [url] = fetchMock.mock.calls[0]!;
    expect(new URL(url as string).searchParams.get('filter')).toBe('streams:default-stream');
  });

  it('uses Basic auth when authType is basic', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ total_results: 0, fields: [], time: 0, messages: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GraylogClient({ ...bearerConn, authType: 'basic', token: undefined, username: 'u', password: 'p' }, config);
    await client.searchAbsolute({ query: 'x', fromMs: 0, toMs: 1 });

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Basic ${Buffer.from('u:p').toString('base64')}` });
  });

  it('throws GraylogApiError with the endpoint path on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' } as Response)));
    const client = new GraylogClient(bearerConn, config);
    await expect(client.searchAbsolute({ query: 'x', fromMs: 0, toMs: 1 })).rejects.toThrow(/Graylog GET .* failed: 500/);
  });
});

describe('GraylogClient.listStreams', () => {
  it('returns the streams array from /api/streams', async () => {
    const streams = [{ id: 's1', title: 'Production Logs' }];
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ streams, total: 1 })));

    const client = new GraylogClient(bearerConn, config);
    await expect(client.listStreams()).resolves.toEqual(streams);
  });
});
