import type { GrafanaClient } from '../grafana/client.js';
import type { Config } from '../config.js';
import { flattenPanels } from '../dashboards/panelQueries.js';
import { findKnowledgeDashboardUid, KNOWLEDGE_TAG } from './folderWalk.js';
import { parseKnowledgePanel, productKeyFromPanelTitle } from './parsePanel.js';
import {
  isCacheEntryStale,
  loadKnowledgeCache,
  saveKnowledgeCache,
  ROOT_FOLDER_KEY,
  type KnowledgeCache,
} from './store.js';
import type { CachedPanelContent, ProductKnowledge } from './types.js';

/** Folder structure changes rarely but isn't never — re-walk periodically rather than caching "no knowledge dashboard here" forever. */
const FOLDER_WALK_TTL_MS = 15 * 60 * 1000;

function folderKey(folderUid: string | undefined): string {
  return folderUid ?? ROOT_FOLDER_KEY;
}

async function resolveKnowledgeDashboardUid(
  client: GrafanaClient,
  cache: KnowledgeCache,
  startFolderUid: string | undefined,
): Promise<string | undefined> {
  const key = folderKey(startFolderUid);
  const cached = cache.folderWalk[key];
  if (!isCacheEntryStale(cached, FOLDER_WALK_TTL_MS)) return cached!.knowledgeDashboardUid ?? undefined;

  const found = await findKnowledgeDashboardUid(client, startFolderUid);
  cache.folderWalk[key] = { knowledgeDashboardUid: found ?? null, resolvedAt: Date.now() };
  return found;
}

/** Same TTL/rationale as the folder-walk cache above — this list just backs the connection-wide fallback instead of the walk-up. */
async function listAllKnowledgeDashboardUids(client: GrafanaClient, cache: KnowledgeCache): Promise<string[]> {
  if (!isCacheEntryStale(cache.allKnowledgeDashboards, FOLDER_WALK_TTL_MS)) {
    return cache.allKnowledgeDashboards!.uids;
  }
  const results = await client.searchDashboards({ tag: [KNOWLEDGE_TAG] });
  const uids = results.map((r) => r.uid);
  cache.allKnowledgeDashboards = { uids, resolvedAt: Date.now() };
  return uids;
}

/**
 * Fetching a knowledge dashboard's body is the only way to know whether it
 * changed (Grafana has no lighter metadata-only version check) — this cache
 * hit still costs one GET, it just skips re-parsing every panel's markdown
 * when the version matches what's cached.
 */
async function loadDashboardPanels(
  client: GrafanaClient,
  cache: KnowledgeCache,
  dashboardUid: string,
): Promise<Record<string, CachedPanelContent>> {
  const { dashboard } = await client.getDashboard(dashboardUid);
  const version = dashboard.version ?? 0;
  const cached = cache.dashboards[dashboardUid];
  if (cached && cached.version === version) return cached.panels;

  const panels: Record<string, CachedPanelContent> = {};
  for (const panel of flattenPanels(dashboard.panels ?? [])) {
    const productKey = productKeyFromPanelTitle(panel.title);
    if (!productKey || typeof panel.options?.content !== 'string') continue;
    const keyLower = productKey.toLowerCase();
    if (panels[keyLower]) continue; // first panel wins if more than one shares a product key — don't throw over a malformed knowledge dashboard
    panels[keyLower] = { panelId: panel.id, panelTitle: panel.title!, ...parseKnowledgePanel(panel.options.content) };
  }
  cache.dashboards[dashboardUid] = { version, resolvedAt: Date.now(), panels };
  return panels;
}

export interface ResolveProductContextInput {
  /** The folder to start walking up from — typically the alert's own resolved dashboard's folder, or undefined for root. */
  startFolderUid: string | undefined;
  /** Tried in order; the first one matching a `timebuddy: <key>` panel wins. */
  candidateKeys: string[];
}

/**
 * Single entry point for both get_alert_context's automatic attachment and
 * the standalone get_product_context tool. Returns undefined on any kind of
 * miss (no knowledge dashboard anywhere in the folder chain and none
 * elsewhere on the connection either, or no panel matching any candidate
 * key) — silent, by design, so an adopter who has published nothing sees no
 * difference. Propagates real transport errors (e.g. Grafana unreachable)
 * rather than swallowing them here; callers for whom this lookup is a
 * non-essential enhancement (get_alert_context) should catch and degrade
 * gracefully themselves rather than fail their whole call.
 */
export async function resolveProductContext(
  client: GrafanaClient,
  config: Config,
  connectionId: string,
  input: ResolveProductContextInput,
): Promise<ProductKnowledge | undefined> {
  const cache = await loadKnowledgeCache(config, connectionId);
  try {
    const tryDashboard = async (dashboardUid: string): Promise<ProductKnowledge | undefined> => {
      const panels = await loadDashboardPanels(client, cache, dashboardUid);
      for (const key of input.candidateKeys) {
        const entry = panels[key.trim().toLowerCase()];
        if (entry) return { dashboardUid, matchedKey: key, ...entry };
      }
      return undefined;
    };

    const walkedUid = await resolveKnowledgeDashboardUid(client, cache, input.startFolderUid);
    if (walkedUid) {
      const found = await tryDashboard(walkedUid);
      if (found) return found;
    }

    // The folder walk-up is a scoping optimization, not a guarantee: an
    // alerting/SLI dashboard is often filed in a folder tree that's never an
    // ancestor of wherever knowledge actually got published (e.g. an
    // "SLI-SLO" alert-rule folder vs. a separate "product-status" tree) —
    // confirmed against a real investigation where this silently produced
    // "no knowledge attached" even though the product's knowledge panel
    // existed elsewhere on the same connection, forcing a manual, connection-
    // wide get_product_context retry. Check every other knowledge dashboard
    // before giving up. If more than one matches the same key (e.g. the same
    // product published under two folder trees), take the first found —
    // a same-product duplicate is still far more useful than nothing, and
    // get_product_context (no dashboardUid) remains available to see every
    // match when that distinction actually matters.
    const allUids = await listAllKnowledgeDashboardUids(client, cache);
    for (const uid of allUids) {
      if (uid === walkedUid) continue; // already tried above
      const found = await tryDashboard(uid);
      if (found) return found;
    }
    return undefined;
  } finally {
    await saveKnowledgeCache(cache, config, connectionId);
  }
}

export interface ProductContextMatch extends ProductKnowledge {
  knowledgeDashboardTitle: string;
  folderUid?: string;
}

export interface KnowledgeDashboardSummary {
  dashboardUid: string;
  title: string;
  folderUid?: string;
  /** Product keys published on this dashboard, from each `timebuddy: <key>` panel — what a caller can pass to get_product_context. */
  productKeys: string[];
}

/**
 * Enumerates every "Timebuddy knowledge" dashboard on a connection, independent
 * of any single product key — for a proactive "here's what's been published"
 * survey (e.g. find_related_dashboards's no-args overview) rather than the
 * targeted, key-first lookups above. Returns an empty array, not an error,
 * when nothing has been published on this connection.
 */
export async function listKnowledgeDashboards(
  client: GrafanaClient,
  config: Config,
  connectionId: string,
): Promise<KnowledgeDashboardSummary[]> {
  const results = await client.searchDashboards({ tag: [KNOWLEDGE_TAG] });
  const cache = await loadKnowledgeCache(config, connectionId);
  try {
    return await Promise.all(
      results.map(async (result) => {
        const panels = await loadDashboardPanels(client, cache, result.uid);
        return {
          dashboardUid: result.uid,
          title: result.title,
          folderUid: result.folderUid,
          productKeys: Object.keys(panels).sort(),
        };
      }),
    );
  } finally {
    await saveKnowledgeCache(cache, config, connectionId);
  }
}

/**
 * Used by get_product_context when called with no dashboardUid to scope the
 * search: checks every dashboard tagged timebuddy-knowledge on this
 * connection for a matching panel, rather than guessing which folder's
 * knowledge applies. Can return more than one match (e.g. the same product
 * key defined in both a staging and a prod knowledge dashboard) — the caller
 * surfaces all of them rather than picking one, consistent with
 * resolveConnection's "ambiguous is explicit, never a guess" precedent.
 */
export async function findProductContextAcrossConnection(
  client: GrafanaClient,
  config: Config,
  connectionId: string,
  productKey: string,
): Promise<ProductContextMatch[]> {
  const results = await client.searchDashboards({ tag: [KNOWLEDGE_TAG] });
  const cache = await loadKnowledgeCache(config, connectionId);
  try {
    const matches: ProductContextMatch[] = [];
    for (const result of results) {
      const panels = await loadDashboardPanels(client, cache, result.uid);
      const entry = panels[productKey.trim().toLowerCase()];
      if (entry) {
        matches.push({ dashboardUid: result.uid, matchedKey: productKey, knowledgeDashboardTitle: result.title, folderUid: result.folderUid, ...entry });
      }
    }
    return matches;
  } finally {
    await saveKnowledgeCache(cache, config, connectionId);
  }
}
