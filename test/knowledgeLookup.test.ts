import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findProductContextAcrossConnection, listKnowledgeDashboards, resolveProductContext } from '../src/knowledge/lookup.js';
import { GrafanaApiError, type GrafanaClient } from '../src/grafana/client.js';
import type { Config } from '../src/config.js';
import type { DashboardGetResponse, SearchResultItem } from '../src/grafana/types.js';

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
  dataDir = await mkdtemp(join(tmpdir(), 'knowledge-lookup-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function knowledgeDashboard(version: number, panels: Array<{ id: number; title: string; content: string }>): DashboardGetResponse {
  return {
    dashboard: {
      uid: 'kb1',
      title: '🧠 Timebuddy knowledge',
      version,
      panels: panels.map((p) => ({ id: p.id, title: p.title, type: 'text', options: { content: p.content, mode: 'markdown' } })),
    },
    meta: { folderUid: 'folder-a' },
  };
}

function fakeClient(opts: { dashboardByUid: Record<string, DashboardGetResponse>; knowledgeSearchResults: SearchResultItem[] }): GrafanaClient {
  return {
    searchDashboards: async () => opts.knowledgeSearchResults,
    // Simulates a top-level folder (no parent) rather than a transport error,
    // so the walk terminates cleanly at "folder-a" instead of trying to walk further.
    getFolder: async (uid: string) => {
      throw new GrafanaApiError('not found', 404, `/api/folders/${uid}`);
    },
    getDashboard: async (uid: string) => {
      const found = opts.dashboardByUid[uid];
      if (!found) throw new Error(`not found: ${uid}`);
      return found;
    },
  } as unknown as GrafanaClient;
}

describe('resolveProductContext', () => {
  it('returns undefined when no knowledge dashboard exists in the folder chain', async () => {
    const client = fakeClient({ dashboardByUid: {}, knowledgeSearchResults: [] });
    const result = await resolveProductContext(client, config(), 'conn1', {
      startFolderUid: 'folder-a',
      candidateKeys: ['block-storage'],
    });
    expect(result).toBeUndefined();
  });

  it('matches the first candidate key with a panel, in the given order', async () => {
    const dash = knowledgeDashboard(1, [
      { id: 5, title: 'timebuddy: block-storage', content: '```json\n{"owner":"storage-team"}\n```\nSome notes.' },
    ]);
    const client = fakeClient({
      dashboardByUid: { kb1: dash },
      knowledgeSearchResults: [{ uid: 'kb1', title: 'K', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid: 'folder-a', url: '' }],
    });
    const result = await resolveProductContext(client, config(), 'conn1', {
      startFolderUid: 'folder-a',
      candidateKeys: ['compute', 'block-storage'], // 'compute' has no matching panel; 'block-storage' does
    });
    expect(result?.matchedKey).toBe('block-storage');
    expect(result?.json).toEqual({ owner: 'storage-team' });
    expect(result?.prose).toBe('Some notes.');
    expect(result?.panelId).toBe(5);
  });

  it('caches an explicit "nothing found" result (folder-walk and the connection-wide fallback) so a repeat call does not search again', async () => {
    let searchCalls = 0;
    const client = {
      searchDashboards: async () => {
        searchCalls++;
        return [];
      },
      getFolder: async (uid: string) => {
        throw new GrafanaApiError('not found', 404, `/api/folders/${uid}`);
      },
      getDashboard: async () => {
        throw new Error('unexpected');
      },
    } as unknown as GrafanaClient;
    const cfg = config();

    await resolveProductContext(client, cfg, 'conn1', { startFolderUid: 'folder-a', candidateKeys: ['x'] });
    // First call costs two searches: the folder walk-up, then the connection-wide
    // fallback once that comes up empty. Both are cached, so the repeat call below
    // must not add any further searches.
    expect(searchCalls).toBe(2);
    await resolveProductContext(client, cfg, 'conn1', { startFolderUid: 'folder-a', candidateKeys: ['x'] });
    expect(searchCalls).toBe(2);
  });

  it('falls back to every other knowledge dashboard on the connection when the folder walk-up finds none', async () => {
    // Simulates the real gap this fallback closes: the alerting dashboard's
    // own folder tree ("folder-a") has no knowledge dashboard anywhere in its
    // ancestor chain, but one is published elsewhere on the connection.
    const dash: DashboardGetResponse = {
      dashboard: { uid: 'kb-elsewhere', title: 'K', version: 1, panels: [{ id: 5, title: 'timebuddy: manageddatabase', type: 'text', options: { content: '```json\n{"owner":"db-team"}\n```\n', mode: 'markdown' } }] },
      meta: { folderUid: 'other-folder' },
    };
    const client = {
      // The folder walk-up's own scoped search (folderUid: 'folder-a') finds
      // nothing; only the fallback's unscoped search (folderUid omitted) sees
      // the dashboard published under a different folder tree.
      searchDashboards: async ({ folderUid }: { folderUid?: string }) =>
        folderUid === 'folder-a' ? [] : [{ uid: 'kb-elsewhere', title: 'K', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid: 'other-folder', url: '' }],
      getFolder: async (uid: string) => {
        throw new GrafanaApiError('not found', 404, `/api/folders/${uid}`);
      },
      getDashboard: async (uid: string) => {
        if (uid !== 'kb-elsewhere') throw new Error(`not found: ${uid}`);
        return dash;
      },
    } as unknown as GrafanaClient;

    const result = await resolveProductContext(client, config(), 'conn1', {
      startFolderUid: 'folder-a',
      candidateKeys: ['manageddatabase'],
    });
    expect(result?.dashboardUid).toBe('kb-elsewhere');
    expect(result?.matchedKey).toBe('manageddatabase');
  });

  it('falls back to another knowledge dashboard when the walked one exists but has no matching panel', async () => {
    const walkedDash = knowledgeDashboard(1, [{ id: 1, title: 'timebuddy: compute', content: '```json\n{}\n```\n' }]);
    const elsewhereDash: DashboardGetResponse = {
      dashboard: { uid: 'kb-elsewhere', title: 'K2', version: 1, panels: [{ id: 2, title: 'timebuddy: manageddatabase', type: 'text', options: { content: '```json\n{"owner":"db-team"}\n```\n', mode: 'markdown' } }] },
      meta: { folderUid: 'other-folder' },
    };
    const client = {
      searchDashboards: async ({ folderUid }: { folderUid?: string }) =>
        folderUid === 'folder-a'
          ? [{ uid: 'kb1', title: 'K', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid: 'folder-a', url: '' }]
          : [
              { uid: 'kb1', title: 'K', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid: 'folder-a', url: '' },
              { uid: 'kb-elsewhere', title: 'K2', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid: 'other-folder', url: '' },
            ],
      getFolder: async (uid: string) => {
        throw new GrafanaApiError('not found', 404, `/api/folders/${uid}`);
      },
      getDashboard: async (uid: string) => (uid === 'kb1' ? walkedDash : elsewhereDash),
    } as unknown as GrafanaClient;

    const result = await resolveProductContext(client, config(), 'conn1', {
      startFolderUid: 'folder-a',
      candidateKeys: ['manageddatabase'],
    });
    expect(result?.dashboardUid).toBe('kb-elsewhere');
  });

  it('does not search further once the folder walk-up already found a match', async () => {
    const dash = knowledgeDashboard(1, [
      { id: 5, title: 'timebuddy: block-storage', content: '```json\n{"owner":"storage-team"}\n```\n' },
    ]);
    let searchCalls = 0;
    const client = {
      searchDashboards: async () => {
        searchCalls++;
        return [{ uid: 'kb1', title: 'K', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid: 'folder-a', url: '' }];
      },
      getFolder: async (uid: string) => {
        throw new GrafanaApiError('not found', 404, `/api/folders/${uid}`);
      },
      getDashboard: async () => dash,
    } as unknown as GrafanaClient;

    const result = await resolveProductContext(client, config(), 'conn1', {
      startFolderUid: 'folder-a',
      candidateKeys: ['block-storage'],
    });
    expect(result?.matchedKey).toBe('block-storage');
    // Folder walk-up's own search (for the knowledge-tagged dashboard) counts
    // as one call; the fallback path must not run a second one on a hit.
    expect(searchCalls).toBe(1);
  });

  it('picks up new panel content once the dashboard version changes', async () => {
    const dashboardByUid: Record<string, DashboardGetResponse> = {
      kb1: knowledgeDashboard(1, [{ id: 5, title: 'timebuddy: block-storage', content: '```json\n{"v":1}\n```\n' }]),
    };
    const searchResults: SearchResultItem[] = [{ uid: 'kb1', title: 'K', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid: 'folder-a', url: '' }];
    const client = fakeClient({ dashboardByUid, knowledgeSearchResults: searchResults });
    const cfg = config();

    const first = await resolveProductContext(client, cfg, 'conn1', { startFolderUid: 'folder-a', candidateKeys: ['block-storage'] });
    expect(first?.json).toEqual({ v: 1 });

    const second = await resolveProductContext(client, cfg, 'conn1', { startFolderUid: 'folder-a', candidateKeys: ['block-storage'] });
    expect(second?.json).toEqual({ v: 1 });

    dashboardByUid.kb1 = knowledgeDashboard(2, [{ id: 5, title: 'timebuddy: block-storage', content: '```json\n{"v":2}\n```\n' }]);
    const third = await resolveProductContext(client, cfg, 'conn1', { startFolderUid: 'folder-a', candidateKeys: ['block-storage'] });
    expect(third?.json).toEqual({ v: 2 });
  });
});

describe('findProductContextAcrossConnection', () => {
  it('returns every matching knowledge dashboard on the connection, not just the first', async () => {
    const stagingDash = knowledgeDashboard(1, [{ id: 1, title: 'timebuddy: block-storage', content: '```json\n{"env":"staging"}\n```\n' }]);
    const prodDash = knowledgeDashboard(1, [{ id: 1, title: 'timebuddy: block-storage', content: '```json\n{"env":"prod"}\n```\n' }]);
    const client = {
      searchDashboards: async () => [
        { uid: 'kb-staging', title: 'K staging', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid: 'staging', url: '' },
        { uid: 'kb-prod', title: 'K prod', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid: 'prod', url: '' },
      ],
      getDashboard: async (uid: string) => (uid === 'kb-staging' ? stagingDash : prodDash),
    } as unknown as GrafanaClient;

    const matches = await findProductContextAcrossConnection(client, config(), 'conn1', 'block-storage');
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.json)).toEqual(expect.arrayContaining([{ env: 'staging' }, { env: 'prod' }]));
  });

  it('returns an empty array, not an error, when nothing has been published', async () => {
    const client = { searchDashboards: async () => [] } as unknown as GrafanaClient;
    const matches = await findProductContextAcrossConnection(client, config(), 'conn1', 'block-storage');
    expect(matches).toEqual([]);
  });
});

describe('listKnowledgeDashboards', () => {
  it('returns an empty array, not an error, when nothing has been published', async () => {
    const client = { searchDashboards: async () => [] } as unknown as GrafanaClient;
    const dashboards = await listKnowledgeDashboards(client, config(), 'conn1');
    expect(dashboards).toEqual([]);
  });

  it('lists every timebuddy-knowledge-tagged dashboard with its published product keys, independent of any single key', async () => {
    const dash = knowledgeDashboard(1, [
      { id: 1, title: 'timebuddy: block-storage', content: '```json\n{"owner":"storage-team"}\n```\n' },
      { id: 2, title: 'timebuddy: compute', content: '```json\n{"owner":"compute-team"}\n```\n' },
      { id: 3, title: 'Not a knowledge panel', content: 'irrelevant' },
    ]);
    const client = {
      searchDashboards: async () => [{ uid: 'kb1', title: '🧠 Timebuddy knowledge', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid: 'folder-a', url: '' }],
      getDashboard: async () => dash,
    } as unknown as GrafanaClient;

    const dashboards = await listKnowledgeDashboards(client, config(), 'conn1');
    expect(dashboards).toEqual([
      { dashboardUid: 'kb1', title: '🧠 Timebuddy knowledge', folderUid: 'folder-a', productKeys: ['block-storage', 'compute'] },
    ]);
  });

  it('returns one entry per knowledge dashboard when more than one is tagged on the connection', async () => {
    const stagingDash = knowledgeDashboard(1, [{ id: 1, title: 'timebuddy: block-storage', content: '```json\n{}\n```\n' }]);
    const prodDash = knowledgeDashboard(1, [{ id: 1, title: 'timebuddy: compute', content: '```json\n{}\n```\n' }]);
    const client = {
      searchDashboards: async () => [
        { uid: 'kb-staging', title: 'K staging', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid: 'staging', url: '' },
        { uid: 'kb-prod', title: 'K prod', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid: 'prod', url: '' },
      ],
      getDashboard: async (uid: string) => (uid === 'kb-staging' ? stagingDash : prodDash),
    } as unknown as GrafanaClient;

    const dashboards = await listKnowledgeDashboards(client, config(), 'conn1');
    expect(dashboards.map((d) => d.dashboardUid)).toEqual(['kb-staging', 'kb-prod']);
    expect(dashboards.map((d) => d.productKeys)).toEqual([['block-storage'], ['compute']]);
  });
});
