import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerDetectCorrelatedAnomalies } from '../src/tools/detectCorrelatedAnomalies.js';
import { GrafanaApiError, type GrafanaClient } from '../src/grafana/client.js';
import type { ConnectionRegistry } from '../src/grafana/registry.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { DashboardGetResponse, DsQueryRequest, DsQueryResponse } from '../src/grafana/types.js';
import { fakeServer } from './toolTestHelpers.js';

let dataDir: string;

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
    dataDir,
    webhookPort: 4318,
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'detect-correlated-scope-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function influxTarget(refId: string): { refId: string; datasource: { uid: string }; query: string; rawQuery: boolean } {
  return { refId, datasource: { uid: 'influx1' }, query: 'SELECT mean("v") FROM "m1" WHERE $timeFilter', rawQuery: true };
}

function numericResponse(refId: string): DsQueryResponse {
  return {
    results: {
      [refId]: {
        frames: [
          {
            schema: { refId, fields: [{ name: 'time', type: 'time' }, { name: 'value', type: 'number' }] },
            data: { values: [[0], [1]] },
          },
        ],
      },
    },
  };
}

interface FakeDashboard {
  uid: string;
  title: string;
  tags?: string[];
  folderUid?: string;
  panelIds: number[];
}

function makeClient(dashboards: FakeDashboard[], opts: { knowledgeUid?: string; knowledgeContent?: string; folderParents?: Record<string, string | undefined> } = {}): GrafanaClient {
  const byUid = new Map<string, DashboardGetResponse>(
    dashboards.map((d) => [
      d.uid,
      {
        dashboard: {
          uid: d.uid,
          title: d.title,
          version: 1,
          tags: d.tags,
          panels: d.panelIds.map((id) => ({ id, title: `${d.title} panel ${id}`, targets: [influxTarget('A')] })),
        },
        meta: { folderUid: d.folderUid },
      },
    ]),
  );
  if (opts.knowledgeUid) {
    byUid.set(opts.knowledgeUid, {
      dashboard: {
        uid: opts.knowledgeUid,
        title: '🧠 Timebuddy knowledge',
        version: 1,
        panels: [{ id: 900, title: 'timebuddy: manageddatabase', type: 'text', options: { content: opts.knowledgeContent ?? '```json\n{}\n```\n', mode: 'markdown' } }],
      },
      meta: { folderUid: 'kb-folder' },
    });
  }

  return {
    searchDashboards: async (args: { tag?: string[]; folderUid?: string }) => {
      if (args?.tag?.includes('timebuddy-knowledge')) {
        if (!opts.knowledgeUid) return [];
        if (args.folderUid !== undefined && args.folderUid !== 'kb-folder') return [];
        return [{ uid: opts.knowledgeUid, title: '🧠 Timebuddy knowledge', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid: 'kb-folder', url: '' }];
      }
      return [...byUid.entries()].map(([uid, d]) => ({ uid, title: d.dashboard.title, type: 'dash-db', tags: d.dashboard.tags ?? [], folderUid: d.meta.folderUid, url: '' }));
    },
    getFolder: async (uid: string) => {
      const parentUid = opts.folderParents?.[uid];
      if (parentUid === undefined && !(uid in (opts.folderParents ?? {}))) {
        throw new GrafanaApiError('not found', 404, `/api/folders/${uid}`);
      }
      return { uid, title: uid, parentUid };
    },
    getDashboard: async (uid: string) => {
      const found = byUid.get(uid);
      if (!found) throw new Error(`not found: ${uid}`);
      return found;
    },
    listDatasources: async () => [{ uid: 'influx1', id: 1, name: 'Influx', type: 'influxdb' }],
    getRuleGroups: async () => ({}),
    queryDs: vi.fn(async (req: DsQueryRequest) => numericResponse(req.queries[0]!.refId)),
  } as unknown as GrafanaClient;
}

function makeRegistry(clientsByConnection: Record<string, GrafanaClient>): ConnectionRegistry {
  const connections: GrafanaConnection[] = Object.keys(clientsByConnection).map((id) => ({ id, name: id, url: `https://${id}.example.com`, authType: 'bearer', token: 'x' }));
  return { list: () => connections, get: (id: string) => clientsByConnection[id]! } as unknown as ConnectionRegistry;
}

describe('detect_correlated_anomalies scope tiering', () => {
  it('stages product (same-dashboard fallback) -> connection -> all-connections when no knowledge is published', async () => {
    const conn1 = makeClient([
      { uid: 'primary', title: 'Primary', panelIds: [1, 2], folderUid: 'folder-sli' },
      { uid: 'other-dash', title: 'Other', panelIds: [10], folderUid: 'folder-other' },
    ]);
    const conn2 = makeClient([{ uid: 'dash2', title: 'Dash2', panelIds: [20] }]);
    const registry = makeRegistry({ conn1, conn2 });
    const { server, call } = fakeServer();
    registerDetectCorrelatedAnomalies(server, { registry, config: config() });

    const base = { primaryDashboardUid: 'primary', primaryPanelId: 1, startsAtMs: Date.parse('2026-07-10T10:00:00Z'), endsAtMs: Date.parse('2026-07-10T11:00:00Z'), connection: 'conn1', limit: 10 };

    const product = (await call('detect_correlated_anomalies', { ...base, scope: 'product' })) as { content: Array<{ text: string }> };
    const productParsed = JSON.parse(product.content[0]!.text);
    expect(productParsed.scope).toBe('product');
    expect(productParsed.productScope).toEqual({ dashboardUids: ['primary'], source: 'same-dashboard-only' });
    expect(productParsed.candidatesChecked).toBe(1);
    expect(productParsed.correlated.map((c: { dashboardUid: string }) => c.dashboardUid)).toEqual(['primary']);
    expect(productParsed.nextScope).toBe('connection');
    expect(productParsed.nextScopeCandidateCount).toBe(1);

    const connectionScope = (await call('detect_correlated_anomalies', { ...base, scope: 'connection' })) as { content: Array<{ text: string }> };
    const connectionParsed = JSON.parse(connectionScope.content[0]!.text);
    expect(connectionParsed.scope).toBe('connection');
    expect(connectionParsed.candidatesChecked).toBe(1);
    expect(connectionParsed.correlated.map((c: { dashboardUid: string }) => c.dashboardUid)).toEqual(['other-dash']);
    expect(connectionParsed.nextScope).toBe('all-connections');
    expect(connectionParsed.nextScopeCandidateCount).toBe(1);

    const allConnections = (await call('detect_correlated_anomalies', { ...base, scope: 'all-connections' })) as { content: Array<{ text: string }> };
    const allParsed = JSON.parse(allConnections.content[0]!.text);
    expect(allParsed.scope).toBe('all-connections');
    expect(allParsed.candidatesChecked).toBe(1);
    expect(allParsed.correlated.map((c: { dashboardUid: string }) => c.dashboardUid)).toEqual(['dash2']);
    expect(allParsed.nextScope).toBeUndefined();
  });

  it('pulls a knowledge-declared dependency into the product tier instead of leaving it for the connection tier', async () => {
    const conn1 = makeClient(
      [
        { uid: 'primary', title: 'Primary', tags: ['manageddatabase'], panelIds: [1, 2], folderUid: 'folder-sli' },
        { uid: 'other-dash', title: 'Other', panelIds: [10], folderUid: 'folder-other' },
      ],
      {
        knowledgeUid: 'kb1',
        knowledgeContent: '```json\n{"links":{"opsDashboard":"/d/other-dash"}}\n```\n',
        folderParents: { 'folder-sli': undefined }, // top-level folder, walk-up stops here and never finds kb1 (different folder tree)
      },
    );
    const conn2 = makeClient([{ uid: 'dash2', title: 'Dash2', panelIds: [20] }]);
    const registry = makeRegistry({ conn1, conn2 });
    const { server, call } = fakeServer();
    registerDetectCorrelatedAnomalies(server, { registry, config: config() });

    const base = { primaryDashboardUid: 'primary', primaryPanelId: 1, startsAtMs: Date.parse('2026-07-10T10:00:00Z'), endsAtMs: Date.parse('2026-07-10T11:00:00Z'), connection: 'conn1', limit: 10 };

    const product = (await call('detect_correlated_anomalies', { ...base, scope: 'product' })) as { content: Array<{ text: string }> };
    const productParsed = JSON.parse(product.content[0]!.text);
    expect(productParsed.productScope.source).toBe('knowledge-dependencies');
    expect(productParsed.productScope.dashboardUids.sort()).toEqual(['other-dash', 'primary']);
    expect(productParsed.candidatesChecked).toBe(2);
    expect(productParsed.correlated.map((c: { dashboardUid: string }) => c.dashboardUid).sort()).toEqual(['other-dash', 'primary']);
    // other-dash's only candidate panel was absorbed into the product tier, so the connection tier is now empty.
    expect(productParsed.nextScope).toBe('connection');
    expect(productParsed.nextScopeCandidateCount).toBe(0);

    const connectionScope = (await call('detect_correlated_anomalies', { ...base, scope: 'connection' })) as { content: Array<{ text: string }> };
    const connectionParsed = JSON.parse(connectionScope.content[0]!.text);
    expect(connectionParsed.candidatesChecked).toBe(0);
    expect(connectionParsed.nextScope).toBe('all-connections');
    expect(connectionParsed.nextScopeCandidateCount).toBe(1);
  });

  it('ignores scope entirely when explicit candidates are given', async () => {
    const conn1 = makeClient([{ uid: 'primary', title: 'Primary', panelIds: [1, 2] }]);
    const registry = makeRegistry({ conn1 });
    const { server, call } = fakeServer();
    registerDetectCorrelatedAnomalies(server, { registry, config: config() });

    const result = (await call('detect_correlated_anomalies', {
      primaryDashboardUid: 'primary',
      primaryPanelId: 1,
      startsAtMs: Date.parse('2026-07-10T10:00:00Z'),
      endsAtMs: Date.parse('2026-07-10T11:00:00Z'),
      connection: 'conn1',
      candidates: [{ dashboardUid: 'primary', panelId: 2, connectionId: 'conn1' }],
      limit: 10,
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.scope).toBeUndefined();
    expect(parsed.productScope).toBeUndefined();
    expect(parsed.candidatesChecked).toBe(1);
  });
});
