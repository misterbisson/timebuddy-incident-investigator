import { describe, expect, it } from 'vitest';
import { findKnowledgeDashboardUid } from '../src/knowledge/folderWalk.js';
import { GrafanaApiError, type GrafanaClient } from '../src/grafana/client.js';
import type { FolderInfo, SearchResultItem } from '../src/grafana/types.js';

function knowledgeResult(uid: string, folderUid?: string): SearchResultItem {
  return { uid, title: '🧠 Timebuddy knowledge', type: 'dash-db', tags: ['timebuddy-knowledge'], folderUid, url: '' };
}

function fakeClient(opts: {
  resultsByFolder: Record<string, SearchResultItem[]>; // key: folderUid, or 'root' for the no-filter/undefined case
  folders?: Record<string, FolderInfo>;
  onGetFolder?: (uid: string) => void;
}): GrafanaClient {
  return {
    searchDashboards: async ({ folderUid }: { folderUid?: string }) => opts.resultsByFolder[folderUid ?? 'root'] ?? [],
    getFolder: async (uid: string) => {
      opts.onGetFolder?.(uid);
      const folder = opts.folders?.[uid];
      if (!folder) throw new GrafanaApiError('not found', 404, `/api/folders/${uid}`);
      return folder;
    },
  } as unknown as GrafanaClient;
}

describe('findKnowledgeDashboardUid', () => {
  it('finds a knowledge dashboard in the starting folder immediately', async () => {
    const client = fakeClient({ resultsByFolder: { 'folder-a': [knowledgeResult('kb1', 'folder-a')] } });
    expect(await findKnowledgeDashboardUid(client, 'folder-a')).toBe('kb1');
  });

  it('walks up to the parent folder when the starting folder has no knowledge dashboard', async () => {
    const client = fakeClient({
      resultsByFolder: { 'folder-a': [], 'folder-parent': [knowledgeResult('kb1', 'folder-parent')] },
      folders: { 'folder-a': { uid: 'folder-a', title: 'A', parentUid: 'folder-parent' } },
    });
    expect(await findKnowledgeDashboardUid(client, 'folder-a')).toBe('kb1');
  });

  it('stops and returns undefined once a top-level folder (no parentUid) has no match', async () => {
    const client = fakeClient({
      resultsByFolder: { 'folder-a': [] },
      folders: { 'folder-a': { uid: 'folder-a', title: 'A' } },
    });
    expect(await findKnowledgeDashboardUid(client, 'folder-a')).toBeUndefined();
  });

  it('returns undefined immediately when starting at root with no match, without walking further', async () => {
    let getFolderCalls = 0;
    const client = fakeClient({ resultsByFolder: { root: [] }, onGetFolder: () => getFolderCalls++ });
    expect(await findKnowledgeDashboardUid(client, undefined)).toBeUndefined();
    expect(getFolderCalls).toBe(0);
  });

  it('filters an unscoped root search to only dashboards actually in the root folder', async () => {
    const client = fakeClient({
      resultsByFolder: { root: [knowledgeResult('kb-other', 'somewhere-else'), knowledgeResult('kb-root', undefined)] },
    });
    expect(await findKnowledgeDashboardUid(client, undefined)).toBe('kb-root');
  });

  it('treats a 404 on getFolder as "stop here", not a thrown error', async () => {
    const client = fakeClient({ resultsByFolder: { 'folder-a': [] }, folders: {} });
    expect(await findKnowledgeDashboardUid(client, 'folder-a')).toBeUndefined();
  });

  it('propagates a genuine transport error rather than treating it as a miss', async () => {
    const client = {
      searchDashboards: async () => [],
      getFolder: async () => {
        throw new Error('ECONNRESET');
      },
    } as unknown as GrafanaClient;
    await expect(findKnowledgeDashboardUid(client, 'folder-a')).rejects.toThrow('ECONNRESET');
  });

  it('detects a folder-parent cycle instead of looping forever', async () => {
    const client = fakeClient({
      resultsByFolder: { 'folder-a': [], 'folder-b': [] },
      folders: {
        'folder-a': { uid: 'folder-a', title: 'A', parentUid: 'folder-b' },
        'folder-b': { uid: 'folder-b', title: 'B', parentUid: 'folder-a' },
      },
    });
    expect(await findKnowledgeDashboardUid(client, 'folder-a')).toBeUndefined();
  });

  it('gives up after maxDepth hops rather than walking an unbounded chain', async () => {
    const folders: Record<string, FolderInfo> = {};
    const resultsByFolder: Record<string, SearchResultItem[]> = {};
    for (let i = 0; i < 20; i++) {
      folders[`folder-${i}`] = { uid: `folder-${i}`, title: `F${i}`, parentUid: `folder-${i + 1}` };
      resultsByFolder[`folder-${i}`] = [];
    }
    let getFolderCalls = 0;
    const client = fakeClient({ resultsByFolder, folders, onGetFolder: () => getFolderCalls++ });
    const result = await findKnowledgeDashboardUid(client, 'folder-0', 3);
    expect(result).toBeUndefined();
    expect(getFolderCalls).toBeLessThanOrEqual(4);
  });
});
