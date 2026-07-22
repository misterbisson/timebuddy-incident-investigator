import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAuthHeader, GrafanaClient } from '../src/grafana/client.js';
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

  it('getLokiLabelValues hits the loki label-values resource path and scopes with query', async () => {
    const { urls } = stubFetch({ status: 'success', data: ['api', 'worker'] });
    const client = new GrafanaClient(connection({ token: 't' }), config());

    const values = await client.getLokiLabelValues('loki1', 'pod', '{job="app"}');

    expect(values).toEqual(['api', 'worker']);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/api/datasources/uid/loki1/resources/loki/api/v1/label/pod/values');
    expect(url.searchParams.get('query')).toBe('{job="app"}');
  });

  it('throws on a datasource-level non-success status even though the proxy returns HTTP 200', async () => {
    stubFetch({ status: 'error', error: 'bad label' }, 200);
    const client = new GrafanaClient(connection({ token: 't' }), config());

    await expect(client.getPrometheusLabelValues('prom1', 'instance', 'up')).rejects.toThrow(/status "error": bad label/);
  });
});
