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

function fakeClient(rule?: RulerAlertRule, resolveShortUrl?: (uid: string) => Promise<{ uid: string; path: string; lastSeenAt: number }>): GrafanaClient {
  return {
    getDashboard: async () => dashboard(),
    getAlertRuleByUid: async () => {
      if (!rule) throw new Error('no rule stubbed');
      return rule;
    },
    resolveShortUrl: async (uid: string) => {
      if (!resolveShortUrl) throw new Error('resolveShortUrl not stubbed');
      return resolveShortUrl(uid);
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

  it('resolves a /goto/<id> share short-link to its canonical dashboard first', async () => {
    const { server, call } = fakeServer();
    registerFetchDashboard(server, {
      registry: fakeRegistry(connections, fakeClient(undefined, async (uid) => ({ uid, path: 'd/checkout/checkout-overview?orgId=1', lastSeenAt: 0 }))),
      config: config(),
    });

    const result = (await call('fetch_dashboard', { url: 'https://grafana.example.com/goto/AT76wBvGk?orgId=1' })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.uid).toBe('checkout');
  });

  it('errors distinctly on an expired/pruned short-link', async () => {
    const { server, call } = fakeServer();
    const { GrafanaApiError } = await import('../src/grafana/client.js');
    registerFetchDashboard(server, {
      registry: fakeRegistry(connections, fakeClient(undefined, async () => {
        throw new GrafanaApiError('Grafana GET /api/short-urls/dead123 failed: 404', 404, '/api/short-urls/dead123');
      })),
      config: config(),
    });

    const result = (await call('fetch_dashboard', { url: 'https://grafana.example.com/goto/dead123' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/expired or was not found/);
  });

  it('errors with a clear message when given a folder link instead of a dashboard', async () => {
    const { server, call } = fakeServer();
    registerFetchDashboard(server, { registry: fakeRegistry(connections, fakeClient()), config: config() });

    const result = (await call('fetch_dashboard', { url: 'https://grafana.example.com/dashboards/f/infra-status/infra-status' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/folder link, not a dashboard/);
    expect(result.content[0]!.text).toMatch(/list_folder_dashboards/);
  });

  it('errors when neither url nor dashboardUid is provided', async () => {
    const { server, call } = fakeServer();
    registerFetchDashboard(server, { registry: fakeRegistry(connections, fakeClient()), config: config() });

    const result = (await call('fetch_dashboard', {})) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Must provide either "url"/);
  });
});
