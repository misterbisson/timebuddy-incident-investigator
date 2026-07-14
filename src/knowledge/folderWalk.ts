import { GrafanaApiError, type GrafanaClient } from '../grafana/client.js';

export const KNOWLEDGE_TAG = 'timebuddy-knowledge';
const MAX_WALK_DEPTH = 10;

/**
 * Walks from a starting folder up through its ancestor chain looking for a
 * dashboard tagged `timebuddy-knowledge` — Grafana has no single "ancestor
 * chain" endpoint, so this means searching one folder, then (on a miss)
 * fetching that folder's own parent and repeating. Stops at the root (the
 * starting folder is undefined, or a folder has no parentUid), on a repeated
 * folder (cycle guard, independent of the depth cap below — a provisioning
 * bug could create a short cycle well inside it), or after maxDepth hops
 * (safety backstop). Returns undefined on a clean miss; only a genuine
 * transport error (not a 404, which means "folder gone, stop here") propagates.
 */
export async function findKnowledgeDashboardUid(
  client: GrafanaClient,
  startFolderUid: string | undefined,
  maxDepth = MAX_WALK_DEPTH,
): Promise<string | undefined> {
  const visited = new Set<string>();
  let currentFolderUid = startFolderUid;

  for (let depth = 0; depth <= maxDepth; depth++) {
    const found = await searchFolderForKnowledgeDashboard(client, currentFolderUid);
    if (found) return found;

    if (currentFolderUid === undefined) return undefined; // root reached, nowhere left to walk
    if (visited.has(currentFolderUid)) return undefined; // cycle guard
    visited.add(currentFolderUid);

    const parentUid = await parentFolderUid(client, currentFolderUid);
    if (!parentUid) return undefined;
    currentFolderUid = parentUid;
  }
  return undefined;
}

async function searchFolderForKnowledgeDashboard(client: GrafanaClient, folderUid: string | undefined): Promise<string | undefined> {
  const results = await client.searchDashboards({ tag: [KNOWLEDGE_TAG], folderUid });
  // searchDashboards has no way to filter to "root only" — a search with no
  // folderUid returns matches from every folder, so the root case is
  // filtered client-side instead.
  const candidates = folderUid === undefined ? results.filter((r) => r.folderUid === undefined) : results;
  return candidates[0]?.uid;
}

async function parentFolderUid(client: GrafanaClient, folderUid: string): Promise<string | undefined> {
  try {
    const folder = await client.getFolder(folderUid);
    return folder.parentUid;
  } catch (err) {
    if (err instanceof GrafanaApiError && err.status === 404) return undefined;
    throw err;
  }
}
