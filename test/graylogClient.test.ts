import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGraylogAuthHeader, GraylogApiError, GraylogClient } from '../src/graylog/client.js';
import type { Config, LogConnection } from '../src/config.js';

function connection(overrides: Partial<LogConnection>): LogConnection {
  return { id: 'test', name: 'test', sourceType: 'graylog', url: 'https://graylog.example.com', authType: 'token', ...overrides };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    connections: [],
    logConnections: [],
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

describe('buildGraylogAuthHeader', () => {
  it('builds a Basic header with the token as username and the literal "token" as password — Graylog\'s own API-token convention, not a Bearer header', () => {
    const header = buildGraylogAuthHeader(connection({ authType: 'token', token: 'abc123' }));
    expect(header).toBe(`Basic ${Buffer.from('abc123:token').toString('base64')}`);
  });

  it('builds a base64-encoded Basic header for a basic (real username/password) connection', () => {
    const header = buildGraylogAuthHeader(connection({ authType: 'basic', username: 'alice', password: 'hunter2' }));
    expect(header).toBe(`Basic ${Buffer.from('alice:hunter2').toString('base64')}`);
  });

  it('throws when a token connection has no token', () => {
    expect(() => buildGraylogAuthHeader(connection({ authType: 'token' }))).toThrow(/missing token/);
  });

  it('throws when a basic connection is missing username or password', () => {
    expect(() => buildGraylogAuthHeader(connection({ authType: 'basic', username: 'alice' }))).toThrow(/missing username\/password/);
  });
});

describe('GraylogClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('searchAbsolute builds the absolute-range URL with ISO from/to, default limit, and wildcard fields', async () => {
    let requestedUrl: string | undefined;
    let requestedHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        requestedUrl = url;
        requestedHeaders = init.headers as Record<string, string>;
        return new Response(JSON.stringify({ messages: [], total_results: 0 }), { status: 200 });
      }),
    );

    const client = new GraylogClient(connection({ token: 'abc123' }), config());
    await client.searchAbsolute({ query: 'service:frontend', fromMs: 1_000, toMs: 2_000 });

    const url = new URL(requestedUrl!);
    expect(url.pathname).toBe('/api/search/universal/absolute');
    expect(url.searchParams.get('query')).toBe('service:frontend');
    expect(url.searchParams.get('from')).toBe(new Date(1_000).toISOString());
    expect(url.searchParams.get('to')).toBe(new Date(2_000).toISOString());
    expect(url.searchParams.get('limit')).toBe('500');
    expect(url.searchParams.get('fields')).toBe('_id,message,timestamp,source,*');
    expect(requestedHeaders?.Authorization).toBe(`Basic ${Buffer.from('abc123:token').toString('base64')}`);
  });

  it('passes an explicit limit through instead of the default', async () => {
    let requestedUrl: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requestedUrl = url;
        return new Response(JSON.stringify({ messages: [], total_results: 0 }), { status: 200 });
      }),
    );
    const client = new GraylogClient(connection({ token: 'abc123' }), config());
    await client.searchAbsolute({ query: '*', fromMs: 0, toMs: 1, limit: 50 });
    expect(new URL(requestedUrl!).searchParams.get('limit')).toBe('50');
  });

  it('filters by the streamId param when given', async () => {
    let requestedUrl: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requestedUrl = url;
        return new Response(JSON.stringify({ messages: [], total_results: 0 }), { status: 200 });
      }),
    );
    const client = new GraylogClient(connection({ token: 'abc123' }), config());
    await client.searchAbsolute({ query: '*', fromMs: 0, toMs: 1, streamId: 'stream-1' });
    expect(new URL(requestedUrl!).searchParams.get('filter')).toBe('streams:stream-1');
  });

  it('falls back to the connection\'s own default streamId when no per-call streamId is given', async () => {
    let requestedUrl: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requestedUrl = url;
        return new Response(JSON.stringify({ messages: [], total_results: 0 }), { status: 200 });
      }),
    );
    const client = new GraylogClient(connection({ token: 'abc123', streamId: 'default-stream' }), config());
    await client.searchAbsolute({ query: '*', fromMs: 0, toMs: 1 });
    expect(new URL(requestedUrl!).searchParams.get('filter')).toBe('streams:default-stream');
  });

  it('omits the filter param when neither a per-call nor a default streamId is set', async () => {
    let requestedUrl: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requestedUrl = url;
        return new Response(JSON.stringify({ messages: [], total_results: 0 }), { status: 200 });
      }),
    );
    const client = new GraylogClient(connection({ token: 'abc123' }), config());
    await client.searchAbsolute({ query: '*', fromMs: 0, toMs: 1 });
    expect(new URL(requestedUrl!).searchParams.has('filter')).toBe(false);
  });

  it('throws a GraylogApiError with status/path on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('server exploded', { status: 500, statusText: 'Internal Server Error' })),
    );
    const client = new GraylogClient(connection({ token: 'abc123' }), config());
    await expect(client.searchAbsolute({ query: '*', fromMs: 0, toMs: 1 })).rejects.toMatchObject({
      status: 500,
      path: expect.stringContaining('/api/search/universal/absolute'),
    });
    await expect(client.searchAbsolute({ query: '*', fromMs: 0, toMs: 1 })).rejects.toBeInstanceOf(GraylogApiError);
  });

  it('listStreams hits /api/streams and returns the streams array', async () => {
    let requestedUrl: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requestedUrl = url;
        return new Response(
          JSON.stringify({ streams: [{ id: 's1', title: 'APIGW 5xx' }], total: 1 }),
          { status: 200 },
        );
      }),
    );
    const client = new GraylogClient(connection({ token: 'abc123' }), config());
    const streams = await client.listStreams();
    expect(new URL(requestedUrl!).pathname).toBe('/api/streams');
    expect(streams).toEqual([{ id: 's1', title: 'APIGW 5xx' }]);
  });
});
