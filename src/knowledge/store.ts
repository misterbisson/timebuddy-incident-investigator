import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { CachedPanelContent } from './types.js';

export interface FolderWalkCacheEntry {
  /** null means "walked the tree, found nothing" — cached explicitly so the common no-adopter case doesn't re-walk on every call. */
  knowledgeDashboardUid: string | null;
  resolvedAt: number;
}

export interface DashboardCacheEntry {
  version: number;
  resolvedAt: number;
  /** Keyed by lowercased product key. */
  panels: Record<string, CachedPanelContent>;
}

export interface AllDashboardsCacheEntry {
  uids: string[];
  resolvedAt: number;
}

export interface KnowledgeCache {
  schemaVersion: number;
  /** Keyed by the starting folder's uid, or ROOT_FOLDER_KEY. */
  folderWalk: Record<string, FolderWalkCacheEntry>;
  /** Keyed by knowledge dashboard uid. */
  dashboards: Record<string, DashboardCacheEntry>;
  /**
   * Every timebuddy-knowledge-tagged dashboard uid on the connection, refreshed on the
   * same TTL as folderWalk. Backs resolveProductContext's connection-wide fallback (for
   * when the folder walk-up finds nothing usable) so a repeat call within the TTL
   * doesn't re-run that search every time. Optional so an older cache file on disk
   * (written before this field existed) is simply treated as stale, not invalid.
   */
  allKnowledgeDashboards?: AllDashboardsCacheEntry;
}

export const CURRENT_SCHEMA_VERSION = 1;
export const ROOT_FOLDER_KEY = 'root';

function emptyCache(): KnowledgeCache {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, folderWalk: {}, dashboards: {} };
}

function cacheDir(config: Config): string {
  return join(config.dataDir, 'knowledge');
}

function cacheFilePath(config: Config, connectionId: string): string {
  return join(cacheDir(config), `${connectionId}.json`);
}

export async function loadKnowledgeCache(config: Config, connectionId: string): Promise<KnowledgeCache> {
  try {
    const text = await readFile(cacheFilePath(config, connectionId), 'utf8');
    const parsed = JSON.parse(text) as KnowledgeCache;
    if (parsed.schemaVersion !== CURRENT_SCHEMA_VERSION) return emptyCache();
    return parsed;
  } catch {
    // Any read/parse failure (missing file, or a corrupted/truncated write
    // from a crash mid-save) falls back to a fresh cache, same as a schema
    // mismatch above.
    return emptyCache();
  }
}

export async function saveKnowledgeCache(cache: KnowledgeCache, config: Config, connectionId: string): Promise<void> {
  await mkdir(cacheDir(config), { recursive: true });
  await writeFile(cacheFilePath(config, connectionId), JSON.stringify(cache, null, 2), 'utf8');
}

/** Shared staleness check for any cache entry carrying a resolvedAt timestamp (folder-walk results, the all-dashboards list). */
export function isCacheEntryStale(entry: { resolvedAt: number } | undefined, ttlMs: number, nowMs = Date.now()): boolean {
  if (!entry) return true;
  return nowMs - entry.resolvedAt > ttlMs;
}
