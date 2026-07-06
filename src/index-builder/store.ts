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

export interface MetricIndex {
  builtAt: string;
  dashboardsScanned: number;
  entriesByMetric: Record<string, MetricIndexEntry[]>;
  brokenDatasources: BrokenDatasourceRef[];
}

function indexFilePath(config: Config): string {
  return join(config.dataDir, 'metric-index.json');
}

export async function loadIndex(config: Config): Promise<MetricIndex | undefined> {
  try {
    const text = await readFile(indexFilePath(config), 'utf8');
    return JSON.parse(text) as MetricIndex;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function saveIndex(index: MetricIndex, config: Config): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(indexFilePath(config), JSON.stringify(index, null, 2), 'utf8');
}

export function isStale(index: MetricIndex, ttlMs: number, nowMs = Date.now()): boolean {
  return nowMs - Date.parse(index.builtAt) > ttlMs;
}
