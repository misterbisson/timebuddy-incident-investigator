import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAuthHeader, DATASOURCES_TTL_MS, GrafanaApiError, GrafanaClient } from '../src/grafana/client.js';
import type { Config, GrafanaConnection } from '../src/config.js';

function connection(overrides: Partial<GrafanaConnection>): GrafanaConnection {
  return { id: 'test', name: 'test', url: 'https://grafana.example.com', authType: 'bearer', ...overrides };
}

function config(): Config {
  return {
    connections: [],
    tlsVerify: true,
    requestTimeoutMs: 1000,
    screenshotTimeoutMs: 45000,
    maxConcurrency: 4,
    maxLookbackHours: 720,
    maxDataPoints: 2000,
    redactionPatterns: [],
    dataDir: '.data',
    webhookPort: 4318,
  };
}

// 2026-03-01T10:00:00Z → 2026-03-02T10:00:00Z
const LOKI_WINDOW = { fromMs: 1772359200000, toMs: 1772445600000 };

describe('buildAuthHeader', () => {
  it('builds a Bearer header for a bearer connection', () => {
    expect(buildAuthHeader(connection({ authType: 'bearer', token: 'glsa_abc123' }))).toBe('Bearer glsa_abc123');
  });

  it('builds a base64-encoded Basic header for a basic connection', () => {
    const header = buildAuthHeader(connection({ authType: 'basic', username: 'alice', password: 'hunter2' }));
    expect(header).toBe(`Basic ${Buffer.from('alice:hunter2').toString('base64')}`);
  });

  it('throws when a bearer connection has no token', () => {
    expect(() => buildAuthHeader(connection({ authType: 'bearer' }))).toThrow(/missing token/);
  });

  it('throws when a basic connection is missing username or password', () => {
    expect(() => buildAuthHeader(connection({ authType: 'basic', username: 'alice' }))).toThrow(/missing username\/password/);
  });
});

describe('GrafanaClient label-values (datasource resources proxy)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: unknown, status = 200): { urls: string[] } {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(body), { status });
      }),
    );
    return { urls };
  }

  it('getPrometheusLabelValues hits the label-values resource path and scopes with match[]', async () => {
    const { urls } = stubFetch({ status: 'success', data: ['web-01', 'web-02'] });
    const client = new GrafanaClient(connection({ token: 't' }), config());

    const values = await client.getPrometheusLabelValues('prom1', 'instance', 'up{job="x"}');

    expect(values).toEqual(['web-01', 'web-02']);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/api/datasources/uid/prom1/resources/api/v1/label/instance/values');
    expect(url.searchParams.get('match[]')).toBe('up{job="x"}');
  });

  it('getPrometheusLabelValues omits match[] when no metric is given', async () => {
    const { urls } = stubFetch({ status: 'success', data: [] });
    const client = new GrafanaClient(connection({ token: 't' }), config());

    await client.getPrometheusLabelValues('prom1', 'instance');

    expect(new URL(urls[0]!).search).toBe('');
  });

  // Grafana's Loki backend prefixes every resource path with /loki/api/v1/
  // itself (unchanged from 9.5 through 12.x), so the resource path is the part
  // *after* that prefix. The previous path repeated it and reached
  // /loki/api/v1/loki/api/v1/label/..., which Loki 404s — while this test
  // asserted the doubled path and passed.
  it('getLokiLabelValues hits the label-values resource path (no repeated /loki/api/v1) and scopes with query', async () => {
    const { urls } = stubFetch({ status: 'success', data: ['api', 'worker'] });
    const client = new GrafanaClient(connection({ token: 't' }), config());

    const values = await client.getLokiLabelValues('loki1', 'pod', LOKI_WINDOW, '{job="app"}');

    expect(values).toEqual(['api', 'worker']);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/api/datasources/uid/loki1/resources/label/pod/values');
    expect(url.searchParams.get('query')).toBe('{job="app"}');
  });

  // #277: Loki defaults both label endpoints to the last hour, so a window
  // is always sent, as Unix nanoseconds.
  it('getLokiLabelValues always sends the window as start/end nanoseconds', async () => {
    const { urls } = stubFetch({ status: 'success', data: [] });
    const client = new GrafanaClient(connection({ token: 't' }), config());

    await client.getLokiLabelValues('loki1', 'pod', LOKI_WINDOW);

    const url = new URL(urls[0]!);
    expect(url.searchParams.get('start')).toBe('1772359200000000000');
    expect(url.searchParams.get('end')).toBe('1772445600000000000');
    expect(url.searchParams.has('query')).toBe(false);
  });

  // #277: Grafana 9.5 through 10.4 only forward a Loki resource URL starting
  // with `labels?` — a bare `labels` is refused before it reaches Loki.
  it('getLokiLabelNames hits the label-names resource path with a query string and the window', async () => {
    const { urls } = stubFetch({ status: 'success', data: ['app', 'env', 'level'] });
    const client = new GrafanaClient(connection({ token: 't' }), config());

    await expect(client.getLokiLabelNames('loki1', LOKI_WINDOW)).resolves.toEqual(['app', 'env', 'level']);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/api/datasources/uid/loki1/resources/labels');
    expect(urls[0]).toContain('/resources/labels?');
    expect(url.searchParams.get('start')).toBe('1772359200000000000');
    expect(url.searchParams.get('end')).toBe('1772445600000000000');
  });

  it('throws on a datasource-level non-success status even though the proxy returns HTTP 200', async () => {
    stubFetch({ status: 'error', error: 'bad label' }, 200);
    const client = new GrafanaClient(connection({ token: 't' }), config());

    await expect(client.getPrometheusLabelValues('prom1', 'instance', 'up')).rejects.toThrow(/status "error": bad label/);
  });

  it('throws on a 200 body that has no data array (not the label-values envelope) instead of reading it as empty', async () => {
    stubFetch({ message: 'Data source not found' }, 200);
    const client = new GrafanaClient(connection({ token: 't' }), config());

    await expect(client.getPrometheusLabelValues('prom1', 'instance', 'up')).rejects.toThrow(/no "data" array/);
  });

  it('returns an empty list for a legitimate empty success envelope', async () => {
    stubFetch({ status: 'success', data: [] }, 200);
    const client = new GrafanaClient(connection({ token: 't' }), config());

    await expect(client.getPrometheusLabelValues('prom1', 'instance', 'up')).resolves.toEqual([]);
  });
});

describe('GrafanaClient preferences endpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hits the fixed user and org preferences paths', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ timezone: 'utc', weekStart: 'monday' }), { status: 200 });
      }),
    );
    const client = new GrafanaClient(connection({ token: 't' }), config());

    await expect(client.getUserPreferences()).resolves.toEqual({ timezone: 'utc', weekStart: 'monday' });
    await expect(client.getOrgPreferences()).resolves.toEqual({ timezone: 'utc', weekStart: 'monday' });
    expect(urls.map((u) => new URL(u).pathname)).toEqual(['/api/user/preferences', '/api/org/preferences']);
  });
});

describe('GrafanaClient.resolveShortUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: unknown, status = 200): { urls: string[] } {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(body), { status });
      }),
    );
    return { urls };
  }

  it('hits GET /api/short-urls/:uid and returns the resolved path', async () => {
    const { urls } = stubFetch({ uid: 'AT76wBvGk', path: 'd/abc123/my-dashboard?orgId=1&viewPanel=3', lastSeenAt: 1780000000000 });
    const client = new GrafanaClient(connection({ token: 't' }), config());

    const result = await client.resolveShortUrl('AT76wBvGk');

    expect(result).toEqual({ uid: 'AT76wBvGk', path: 'd/abc123/my-dashboard?orgId=1&viewPanel=3', lastSeenAt: 1780000000000 });
    expect(new URL(urls[0]!).pathname).toBe('/api/short-urls/AT76wBvGk');
  });

  it('throws a GrafanaApiError with status 404 for an unknown/expired short-link uid', async () => {
    stubFetch({ message: 'shorturl not found' }, 404);
    const client = new GrafanaClient(connection({ token: 't' }), config());

    const err = await client.resolveShortUrl('dead123').catch((e) => e);
    expect(err).toBeInstanceOf(GrafanaApiError);
    expect((err as InstanceType<typeof GrafanaApiError>).status).toBe(404);
  });
});

describe('GrafanaClient.searchFolders', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: unknown, status = 200): { urls: string[] } {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(body), { status });
      }),
    );
    return { urls };
  }

  it('searches with type=dash-folder scoped to a folderUid', async () => {
    const { urls } = stubFetch([{ uid: 'sub1', title: 'Subfolder', type: 'dash-folder', tags: [], url: '/dashboards/f/sub1/subfolder' }]);
    const client = new GrafanaClient(connection({ token: 't' }), config());

    const results = await client.searchFolders({ folderUid: 'infra-status' });

    expect(results).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/api/search');
    expect(url.searchParams.get('type')).toBe('dash-folder');
    expect(url.searchParams.get('folderUIDs')).toBe('infra-status');
  });
});

describe('GrafanaClient.listDatasources memo (#262)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubFetch(responses: Array<{ body: unknown; status?: number }>): { calls: () => number } {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const r = responses[Math.min(n, responses.length - 1)]!;
        n += 1;
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
      }),
    );
    return { calls: () => n };
  }

  const ds = [{ uid: 'a', id: 1, name: 'A', type: 'prometheus' }];

  it('answers concurrent and repeat calls within the TTL from one request', async () => {
    const { calls } = stubFetch([{ body: ds }]);
    const client = new GrafanaClient(connection({ token: 't' }), config());
    await Promise.all([client.listDatasources(), client.listDatasources()]);
    await client.listDatasources();
    expect(calls()).toBe(1);
  });

  it('re-fetches once the TTL has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { calls } = stubFetch([{ body: ds }]);
    const client = new GrafanaClient(connection({ token: 't' }), config());
    await client.listDatasources();
    vi.setSystemTime(Date.now() + DATASOURCES_TTL_MS + 1);
    await client.listDatasources();
    expect(calls()).toBe(2);
  });

  it('does not cache a failed request', async () => {
    const { calls } = stubFetch([{ body: { message: 'boom' }, status: 500 }, { body: ds }]);
    const client = new GrafanaClient(connection({ token: 't' }), config());
    await expect(client.listDatasources()).rejects.toBeInstanceOf(GrafanaApiError);
    await expect(client.listDatasources()).resolves.toEqual(ds);
    expect(calls()).toBe(2);
  });
});
