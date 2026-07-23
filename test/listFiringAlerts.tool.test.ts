import { describe, expect, it, vi } from 'vitest';
import { registerListFiringAlerts, filterFiringAlerts } from '../src/tools/listFiringAlerts.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { AlertmanagerAlert } from '../src/grafana/types.js';
import { GrafanaApiError } from '../src/grafana/client.js';
import { fakeRegistry, fakeServer } from './toolTestHelpers.js';

const connections: GrafanaConnection[] = [
  { id: 'eu', name: 'prd-eu-central-1', url: 'https://metrics.eu-central-1.example.com', authType: 'bearer', token: 'x' },
  { id: 'us', name: 'prd-us-east-1', url: 'https://metrics.us-east-1.example.com', authType: 'bearer', token: 'y' },
];

function alert(overrides: Partial<AlertmanagerAlert> = {}): AlertmanagerAlert {
  return {
    fingerprint: 'fp-1',
    status: { state: 'firing' },
    labels: { alertname: 'MDAS Gateway', region: 'eu-central-1', severity: 'critical' },
    annotations: { summary: 'gateway failures' },
    startsAt: '2026-07-23T19:25:00Z',
    endsAt: '0001-01-01T00:00:00Z',
    generatorURL: 'https://metrics.eu-central-1.example.com/alerting/grafana/abc/view',
    ...overrides,
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    connections,
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

function fakeGrafanaClientWithAlerts(alerts: AlertmanagerAlert[] | (() => Promise<AlertmanagerAlert[]>)): GrafanaClient {
  return {
    getFiringAlerts: typeof alerts === 'function' ? vi.fn(alerts) : vi.fn(async () => alerts),
  } as unknown as GrafanaClient;
}

describe('filterFiringAlerts', () => {
  it('filters by exact label match on all provided pairs', () => {
    const alerts = [
      alert({ fingerprint: 'a', labels: { region: 'eu-central-1', severity: 'critical' } }),
      alert({ fingerprint: 'b', labels: { region: 'eu-central-1', severity: 'warning' } }),
      alert({ fingerprint: 'c', labels: { region: 'us-east-1', severity: 'critical' } }),
    ];
    const out = filterFiringAlerts(alerts, { labelFilters: { region: 'eu-central-1', severity: 'critical' } });
    expect(out.map((a) => a.fingerprint)).toEqual(['a']);
  });

  it('sorts most-recently-started first and truncates to limit', () => {
    const alerts = [
      alert({ fingerprint: 'old', startsAt: '2026-07-23T10:00:00Z' }),
      alert({ fingerprint: 'new', startsAt: '2026-07-23T20:00:00Z' }),
      alert({ fingerprint: 'mid', startsAt: '2026-07-23T15:00:00Z' }),
    ];
    const out = filterFiringAlerts(alerts, { limit: 2 });
    expect(out.map((a) => a.fingerprint)).toEqual(['new', 'mid']);
  });

  it('drops endsAt for still-firing alerts but keeps it for resolved ones', () => {
    const firing = filterFiringAlerts([alert({ status: { state: 'firing' }, endsAt: '2026-07-23T21:00:00Z' })]);
    expect(firing[0]!.endsAt).toBeUndefined();
    const resolved = filterFiringAlerts([alert({ status: { state: 'resolved' }, endsAt: '2026-07-23T21:00:00Z' })]);
    expect(resolved[0]!.endsAt).toBe('2026-07-23T21:00:00Z');
  });
});

describe('list_firing_alerts tool', () => {
  it('returns each alert in a get_alert_context-ingestable shape, grouped by connection', async () => {
    const client = fakeGrafanaClientWithAlerts([alert()]);
    const { server, call } = fakeServer();
    registerListFiringAlerts(server, { registry: fakeRegistry(connections, client), config: config() } as never);

    const result = (await call('list_firing_alerts', { connection: 'eu' })) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0]!.text);

    expect(body.count).toBe(1);
    const entry = body.alertsByConnection.eu[0];
    // The exact fields get_alert_context's alertJson path (isSingleAlert) needs.
    expect(entry).toMatchObject({
      fingerprint: 'fp-1',
      status: { state: 'firing' },
      labels: { alertname: 'MDAS Gateway' },
      annotations: { summary: 'gateway failures' },
      source: 'https://metrics.eu-central-1.example.com/alerting/grafana/abc/view',
    });
    expect(entry.alerts).toBeUndefined();
  });

  it('fans out across every connection when "connection" is omitted', async () => {
    const client = fakeGrafanaClientWithAlerts([alert()]);
    const { server, call } = fakeServer();
    registerListFiringAlerts(server, { registry: fakeRegistry(connections, client), config: config() } as never);

    const result = (await call('list_firing_alerts', {})) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0]!.text);
    expect(Object.keys(body.alertsByConnection).sort()).toEqual(['eu', 'us']);
  });

  it('reports connections it could not reach as failedConnections rather than as all-clear', async () => {
    // registry.get returns a client that always throws for both connections.
    const throwing = {
      getFiringAlerts: vi.fn(async () => {
        throw new GrafanaApiError('GET /api/alertmanager/grafana/api/v2/alerts failed: 502', 502, '/api/alertmanager/grafana/api/v2/alerts');
      }),
    } as unknown as GrafanaClient;
    const { server, call } = fakeServer();
    registerListFiringAlerts(server, { registry: fakeRegistry(connections, throwing), config: config() } as never);

    const result = (await call('list_firing_alerts', {})) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0]!.text);
    expect(body.count).toBe(0);
    expect(body.failedConnections.sort()).toEqual(['eu', 'us']);
  });

  it('redacts configured identifiers in alert labels before returning them', async () => {
    const client = fakeGrafanaClientWithAlerts([alert({ labels: { alertname: 'x', account: 'acct-778899' } })]);
    const { server, call } = fakeServer();
    registerListFiringAlerts(server, {
      registry: fakeRegistry(connections, client),
      config: config({ redactionPatterns: [/acct-\d+/i] }),
    } as never);

    const result = (await call('list_firing_alerts', { connection: 'eu' })) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).not.toContain('acct-778899');
    expect(result.content[0]!.text).toContain('[REDACTED]');
  });

  it('returns an error result for an unknown connection id', async () => {
    const client = fakeGrafanaClientWithAlerts([]);
    const { server, call } = fakeServer();
    registerListFiringAlerts(server, { registry: fakeRegistry(connections, client), config: config() } as never);

    const result = (await call('list_firing_alerts', { connection: 'bogus' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/bogus/);
  });
});
