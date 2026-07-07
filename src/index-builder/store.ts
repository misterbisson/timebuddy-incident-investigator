import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';

export interface MetricIndexEntry {
  dashboardUid: string;
  dashboardTitle: string;
  panelId: number;
  panelTitle?: string;
  datasourceUid?: string;
  /** Label/tag key -> observed values, for label-overlap ranking downstream. */
  labels: Record<string, string[]>;
}

export interface BrokenDatasourceRef {
  dashboardUid: string;
  dashboardTitle: string;
  panelId: number;
  datasourceUid?: string;
}

export interface AlertRuleRef {
  uid: string;
  title: string;
  labels: Record<string, string>;
  folderUid?: string;
}

/**
 * A panel that a real Grafana alert rule points at via its __dashboardUid__/
 * __panelId__ annotations — the strongest available signal that a dashboard
 * is actually relied on, as opposed to a test/scratch/deprecated one that
 * merely matches a search term. Deliberately a separate structure from
 * MetricIndexEntry rather than a field bolted onto it: entriesByMetric only
 * covers panels where metric-name extraction succeeded (a best-effort regex
 * scan), and a panel backing a real alert could easily use a query shape
 * that extraction can't parse — missing exactly the panels that matter most.
 */
export interface AlertBackedPanelRef {
  dashboardUid: string;
  dashboardTitle: string;
  panelId: number;
  panelTitle?: string;
  alertRules: AlertRuleRef[];
}

export interface MetricIndex {
  builtAt: string;
  dashboardsScanned: number;
  entriesByMetric: Record<string, MetricIndexEntry[]>;
  brokenDatasources: BrokenDatasourceRef[];
  alertBackedPanels: AlertBackedPanelRef[];
  /**
   * Set when the alert-rule crawl (getRuleGroups()) failed — e.g. a
   * permission-scoped token — so alertBackedPanels being empty can be told
   * apart from "we tried and there genuinely are none" from "we couldn't
   * even ask." Optional and safe to read as undefined everywhere; never
   * assume its presence.
   */
  alertRuleAccessError?: string;
}

function indexDir(config: Config): string {
  return join(config.dataDir, 'metric-index');
}

function indexFilePath(config: Config, connectionId: string): string {
  return join(indexDir(config), `${connectionId}.json`);
}

export async function loadIndex(config: Config, connectionId: string): Promise<MetricIndex | undefined> {
  try {
    const text = await readFile(indexFilePath(config, connectionId), 'utf8');
    const parsed = JSON.parse(text) as MetricIndex;
    // Cached indexes may predate fields added to MetricIndex since they were
    // written; backfill so older cache files on disk don't crash consumers
    // that assume every field is present.
    return { ...parsed, alertBackedPanels: parsed.alertBackedPanels ?? [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function saveIndex(index: MetricIndex, config: Config, connectionId: string): Promise<void> {
  await mkdir(indexDir(config), { recursive: true });
  await writeFile(indexFilePath(config, connectionId), JSON.stringify(index, null, 2), 'utf8');
}

export function isStale(index: MetricIndex, ttlMs: number, nowMs = Date.now()): boolean {
  return nowMs - Date.parse(index.builtAt) > ttlMs;
}
