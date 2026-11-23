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

function influxTarget(refId: string, query = `SELECT mean("v") FROM "m1" WHERE $timeFilter`): { refId: string; datasource: { uid: string }; query: string; rawQuery: boolean } {
  return { refId, datasource: { uid: 'influx1' }, query, rawQuery: true };
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
  /** InfluxQL for every panel on this dashboard; defaults to a query over measurement m1. */
  query?: string;
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
          panels: d.panelIds.map((id) => ({ id, title: `${d.title} panel ${id}`, targets: [influxTarget('A', d.query)] })),
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
  return {
    list: async () => connections,
    get: async (id: string) => clientsByConnection[id]!,
    resolve: async (id: string) => ({ client: clientsByConnection[id]!, connection: connections.find((c) => c.id === id)! }),
  } as unknown as ConnectionRegistry;
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
    expect(productParsed.productScope).toEqual({
      dashboardUids: ['primary'],
      source: 'same-dashboard-only',
      dashboards: [{ dashboardUid: 'primary', dashboardTitle: 'Primary', queryablePanels: 1, checked: 1 }],
    });
    expect(productParsed.candidateBasis).toEqual({ kind: 'listed-dashboards' });
    expect(productParsed.productScopeIncomplete).toBeUndefined();
    expect(productParsed.candidatesChecked).toBe(1);
    expect(productParsed.correlated.map((c: { dashboardUid: string }) => c.dashboardUid)).toEqual(['primary']);
    expect(productParsed.nextScope).toBe('connection');
    expect(productParsed.nextScopeCandidateCount).toBe(1);
    // Product scope only saw the primary dashboard, and there's an unchecked same-connection panel
    // (other-dash) — so containment is explicitly flagged as not yet established.
    expect(productParsed.containmentCheckIncomplete).toBe(true);
    expect(productParsed.containmentHint).toContain('scope:"connection"');

    const connectionScope = (await call('detect_correlated_anomalies', { ...base, scope: 'connection' })) as { content: Array<{ text: string }> };
    const connectionParsed = JSON.parse(connectionScope.content[0]!.text);
    expect(connectionParsed.scope).toBe('connection');
    expect(connectionParsed.candidateBasis).toEqual({ kind: 'metric-name', metrics: ['m1'] });
    expect(connectionParsed.productScope.dashboards).toBeUndefined();
    // The connection tier has now been checked, so the containment flag is gone.
    expect(connectionParsed.containmentCheckIncomplete).toBeUndefined();
    expect(connectionParsed.candidatesChecked).toBe(1);
    expect(connectionParsed.correlated.map((c: { dashboardUid: string }) => c.dashboardUid)).toEqual(['other-dash']);
    expect(connectionParsed.nextScope).toBe('all-connections');
    // conn2's index hasn't been built yet at this point (a "connection"-scope call never forces
    // a build for connections beyond the primary - see detectCorrelatedAnomalies.ts), so the
    // count for the next, wider tier is intentionally omitted rather than guessed.
    expect(connectionParsed.nextScopeCandidateCount).toBeUndefined();

    const allConnections = (await call('detect_correlated_anomalies', { ...base, scope: 'all-connections' })) as { content: Array<{ text: string }> };
    const allParsed = JSON.parse(allConnections.content[0]!.text);
    expect(allParsed.scope).toBe('all-connections');
    expect(allParsed.candidatesChecked).toBe(1);
    expect(allParsed.correlated.map((c: { dashboardUid: string }) => c.dashboardUid)).toEqual(['dash2']);
    expect(allParsed.nextScope).toBeUndefined();

    // Now that the all-connections call above has built and cached conn2's index, a later
    // "connection"-scope call can report the next tier's count cheaply, from that cache, without
    // forcing a fresh crawl.
    const connectionScopeAgain = (await call('detect_correlated_anomalies', { ...base, scope: 'connection' })) as { content: Array<{ text: string }> };
    const connectionAgainParsed = JSON.parse(connectionScopeAgain.content[0]!.text);
    expect(connectionAgainParsed.nextScopeCandidateCount).toBe(1);
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
    // With no unchecked same-connection panels left, product scope alone is a complete
    // same-connection containment check, so the flag must not be raised.
    expect(productParsed.containmentCheckIncomplete).toBeUndefined();

    const connectionScope = (await call('detect_correlated_anomalies', { ...base, scope: 'connection' })) as { content: Array<{ text: string }> };
    const connectionParsed = JSON.parse(connectionScope.content[0]!.text);
    expect(connectionParsed.candidatesChecked).toBe(0);
    expect(connectionParsed.nextScope).toBe('all-connections');
    // Same reasoning as the other test above: conn2 was never indexed by the "product" call
    // (which never needs any connection but the primary), so this hint is omitted, not guessed.
    expect(connectionParsed.nextScopeCandidateCount).toBeUndefined();
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

describe('product scope compares every listed dashboard (issue #310)', () => {
  const window = { startsAtMs: Date.parse('2026-07-10T10:00:00Z'), endsAtMs: Date.parse('2026-07-10T11:00:00Z') };
  const cpu = 'SELECT mean("v") FROM "cpu" WHERE $timeFilter';

  function productClient(dashboards: FakeDashboard[], dependencyUids: string[]): GrafanaClient {
    const deps = dependencyUids.map((uid) => `{"ref":"${uid}","url":"/d/${uid}"}`).join(',');
    return makeClient(dashboards, {
      knowledgeUid: 'kb1',
      knowledgeContent: `\`\`\`json\n{"sli":{"data":{"dependencies":[${deps}]}}}\n\`\`\`\n`,
      folderParents: { 'folder-sli': undefined },
    });
  }

  async function run(client: GrafanaClient, args: Record<string, unknown>) {
    const { server, call } = fakeServer();
    registerDetectCorrelatedAnomalies(server, { registry: makeRegistry({ conn1: client }), config: config() });
    const result = (await call('detect_correlated_anomalies', {
      primaryDashboardUid: 'primary',
      primaryPanelId: 1,
      ...window,
      connection: 'conn1',
      limit: 10,
      ...args,
    })) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0]!.text);
  }

  it('compares a dependency dashboard whose panels use a different metric than the primary', async () => {
    const client = productClient(
      [
        { uid: 'primary', title: 'Primary', tags: ['manageddatabase'], panelIds: [1], folderUid: 'folder-sli' },
        { uid: 'dep-compute', title: 'Compute', panelIds: [30, 31], folderUid: 'folder-other', query: cpu },
      ],
      ['dep-compute'],
    );
    const parsed = await run(client, { scope: 'product' });
    // Before #310 this was 0: neither panel shares the primary's measurement, so
    // the dependency was listed in productScope but never compared.
    expect(parsed.candidatesChecked).toBe(2);
    expect(parsed.correlated.map((c: { dashboardUid: string; panelId: number }) => `${c.dashboardUid}/${c.panelId}`).sort()).toEqual([
      'dep-compute/30',
      'dep-compute/31',
    ]);
    expect(parsed.candidateBasis).toEqual({ kind: 'listed-dashboards' });
    expect(parsed.productScope.dashboards).toEqual([
      { dashboardUid: 'primary', dashboardTitle: 'Primary', queryablePanels: 0, checked: 0 },
      { dashboardUid: 'dep-compute', dashboardTitle: 'Compute', queryablePanels: 2, checked: 2 },
    ]);
    expect(parsed.productScopeIncomplete).toBeUndefined();
  });

  it('shares the cap across dashboards and reports what it left out', async () => {
    const primaryPanels = Array.from({ length: 20 }, (_, i) => i + 1);
    const client = productClient(
      [
        { uid: 'primary', title: 'Primary', tags: ['manageddatabase'], panelIds: primaryPanels, folderUid: 'folder-sli' },
        { uid: 'dep-compute', title: 'Compute', panelIds: [30, 31, 32, 33, 34], folderUid: 'folder-other', query: cpu },
      ],
      ['dep-compute'],
    );
    // limit 1 -> a cap of 15 panels. Taking the primary dashboard's 19 other
    // panels first would leave the dependency with none; round-robin gives it
    // all 5 and the primary board the remaining 10.
    const parsed = await run(client, { scope: 'product', limit: 1 });
    expect(parsed.candidatesChecked).toBe(15);
    const [primary, dep] = parsed.productScope.dashboards;
    expect(dep).toEqual({ dashboardUid: 'dep-compute', dashboardTitle: 'Compute', queryablePanels: 5, checked: 5 });
    expect(primary).toMatchObject({ dashboardUid: 'primary', queryablePanels: 19, checked: 10 });
    expect(primary.uncheckedPanelIds).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(parsed.productScopeIncomplete).toBe(true);
    expect(parsed.productScopeHint).toContain('"Primary": 9 of 19 panels not compared');
    expect(parsed.productScopeHint).toContain('uncheckedPanelIds');
  });

  it('reports a listed dashboard that could not be read instead of treating it as checked', async () => {
    const client = productClient(
      [{ uid: 'primary', title: 'Primary', tags: ['manageddatabase'], panelIds: [1, 2], folderUid: 'folder-sli' }],
      ['gone'],
    );
    const parsed = await run(client, { scope: 'product' });
    expect(parsed.productScope.dashboardUids).toContain('gone');
    expect(parsed.productScope.dashboards[1]).toEqual({ dashboardUid: 'gone', queryablePanels: 0, checked: 0, error: 'not found: gone' });
    expect(parsed.productScopeIncomplete).toBe(true);
    expect(parsed.productScopeHint).toContain('"gone" couldn\'t be read');
  });

  it('warns at connection scope when no metric could be read from the primary query', async () => {
    const client = makeClient([
      { uid: 'primary', title: 'Primary', panelIds: [1], folderUid: 'folder-sli', query: 'SHOW DATABASES' },
      { uid: 'other', title: 'Other', panelIds: [10], folderUid: 'folder-other' },
    ]);
    const parsed = await run(client, { scope: 'connection' });
    expect(parsed.candidateBasis).toEqual({ kind: 'metric-name', metrics: [] });
    expect(parsed.candidatesChecked).toBe(0);
    expect(parsed.candidateWarning).toContain('not evidence that nothing else moved');
  });
});
