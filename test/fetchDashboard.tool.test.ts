import { describe, expect, it } from 'vitest';
import { registerFetchDashboard } from '../src/tools/fetchDashboard.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { DashboardGetResponse, RulerAlertRule } from '../src/grafana/types.js';
import { fakeRegistry, fakeServer } from './toolTestHelpers.js';

const connections: GrafanaConnection[] = [
  { id: 'test', name: 'test', url: 'https://grafana.example.com', authType: 'bearer', token: 'x' },
];

function config(): Config {
  return {
    connections,
    tlsVerify: true,
    requestTimeoutMs: 1000,
    screenshotTimeoutMs: 45000,
    maxConcurrency: 4,
    maxLookbackHours: 720,
    maxDataPoints: 2000,
    redactionPatterns: [],
    dataDir: '/tmp/fetch-dashboard-tool-test',
    webhookPort: 4318,
  };
}

function dashboard(): DashboardGetResponse {
  return {
    dashboard: { uid: 'checkout', title: 'Checkout overview', panels: [{ id: 1, title: 'Requests', targets: [{ refId: 'A' }] }] },
    meta: {},
  };
}

function fakeClient(rule?: RulerAlertRule): GrafanaClient {
  return {
    getDashboard: async () => dashboard(),
    getAlertRuleByUid: async () => {
      if (!rule) throw new Error('no rule stubbed');
      return rule;
    },
  } as unknown as GrafanaClient;
}

describe('fetch_dashboard tool', () => {
  it('fetches by dashboardUid directly, unchanged from before url support was added', async () => {
    const { server, call } = fakeServer();
    registerFetchDashboard(server, { registry: fakeRegistry(connections, fakeClient()), config: config() });

    const result = (await call('fetch_dashboard', { dashboardUid: 'checkout', connection: 'test' })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.uid).toBe('checkout');
    expect(parsed.panels).toHaveLength(1);
  });

  it('resolves the dashboard uid and connection from a dashboard url', async () => {
    const { server, call } = fakeServer();
    registerFetchDashboard(server, { registry: fakeRegistry(connections, fakeClient()), config: config() });

    const result = (await call('fetch_dashboard', { url: 'https://grafana.example.com/d/checkout/checkout-overview?orgId=1' })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.uid).toBe('checkout');
  });

  it('resolves an alert-rule url to its linked dashboard', async () => {
    const rule: RulerAlertRule = {
      uid: 'rule1',
      title: 'High latency',
      condition: 'A',
      data: [],
      annotations: { __dashboardUid__: 'checkout' },
    };
    const { server, call } = fakeServer();
    registerFetchDashboard(server, { registry: fakeRegistry(connections, fakeClient(rule)), config: config() });

    const result = (await call('fetch_dashboard', { url: 'https://grafana.example.com/alerting/grafana/rule1/view' })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.uid).toBe('checkout');
  });

  it('errors when an alert-rule url has no linked dashboard', async () => {
    const rule: RulerAlertRule = { uid: 'rule1', title: 'High latency', condition: 'A', data: [], annotations: {} };
    const { server, call } = fakeServer();
    registerFetchDashboard(server, { registry: fakeRegistry(connections, fakeClient(rule)), config: config() });

    const result = (await call('fetch_dashboard', { url: 'https://grafana.example.com/alerting/grafana/rule1/view' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/has no linked dashboard/);
  });

  it('errors when neither url nor dashboardUid is provided', async () => {
    const { server, call } = fakeServer();
    registerFetchDashboard(server, { registry: fakeRegistry(connections, fakeClient()), config: config() });

    const result = (await call('fetch_dashboard', {})) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Must provide either "url"/);
  });
});
