import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerFindRelatedDashboards } from '../src/tools/findRelatedDashboards.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { DashboardGetResponse } from '../src/grafana/types.js';
import { fakeRegistry, fakeServer } from './toolTestHelpers.js';

const connections: GrafanaConnection[] = [{ id: 'test', name: 'test', url: 'https://grafana.example.com', authType: 'bearer', token: 'x' }];

let dataDir: string;

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
    dataDir,
    webhookPort: 4318,
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'find-related-dashboards-tool-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function ordinaryDashboard(): DashboardGetResponse {
  return {
    dashboard: {
      uid: 'checkout',
      title: 'Checkout overview',
      panels: [{ id: 1, title: 'Requests', targets: [{ refId: 'A', datasource: { uid: 'prom1' }, expr: 'http_requests_total' }] }],
    },
    meta: {},
  };
}

function knowledgeDashboard(): DashboardGetResponse {
  return {
    dashboard: {
      uid: 'kb1',
      title: '🧠 Timebuddy knowledge',
      panels: [
        { id: 1, title: 'timebuddy: block-storage', type: 'text', options: { content: '```json\n{"owner":"storage-team"}\n```\n' } },
      ],
    },
    meta: { folderUid: 'folder-a' },
  };
}

function fakeClient(): GrafanaClient {
  const byUid: Record<string, DashboardGetResponse> = { checkout: ordinaryDashboard(), kb1: knowledgeDashboard() };
  return {
    searchDashboards: async (opts?: { tag?: string[] }) => {
      if (opts?.tag?.includes('timebuddy-knowledge')) {
        return [{ uid: 'kb1', title: '🧠 Timebuddy knowledge', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid: 'folder-a', url: '' }];
      }
      return [{ uid: 'checkout', title: 'Checkout overview', type: 'dash-db', tags: [], url: '' }];
    },
    listDatasources: async () => [{ uid: 'prom1', id: 1, name: 'Prometheus', type: 'prometheus' }],
    getRuleGroups: async () => ({}),
    getDashboard: async (uid: string) => {
      const found = byUid[uid];
      if (!found) throw new Error(`not found: ${uid}`);
      return found;
    },
  } as unknown as GrafanaClient;
}

describe('find_related_dashboards tool', () => {
  it('reports knowledgeDashboards as a standing overview, alongside the regular metric-index crawl', async () => {
    const client = fakeClient();
    const { server, call } = fakeServer();
    registerFindRelatedDashboards(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('find_related_dashboards', { connection: 'test' })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.knowledgeDashboardsTotal).toBe(1);
    expect(parsed.knowledgeDashboards).toEqual([
      {
        dashboardUid: 'kb1',
        title: '🧠 Timebuddy knowledge',
        folderUid: 'folder-a',
        productKeys: ['block-storage'],
        connectionId: 'test',
        url: 'https://grafana.example.com/d/kb1',
      },
    ]);
    // The regular metric-index crawl (unrelated to knowledge dashboards) still works.
    expect(parsed.dashboardsScanned.test).toBe(1);
  });

  it('reports an empty knowledgeDashboards list, not an error, when nothing has been published', async () => {
    const client = {
      searchDashboards: async () => [],
      listDatasources: async () => [],
      getRuleGroups: async () => ({}),
      getDashboard: async () => {
        throw new Error('unexpected');
      },
    } as unknown as GrafanaClient;
    const { server, call } = fakeServer();
    registerFindRelatedDashboards(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('find_related_dashboards', { connection: 'test' })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.knowledgeDashboardsTotal).toBe(0);
    expect(parsed.knowledgeDashboards).toEqual([]);
  });
});
