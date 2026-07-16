import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, isStale, loadIndex, saveIndex, type MetricIndex } from '../src/index-builder/store.js';
import type { Config } from '../src/config.js';

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
  dataDir = await mkdtemp(join(tmpdir(), 'metric-index-store-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('loadIndex', () => {
  it('returns undefined when no cache file exists yet', async () => {
    expect(await loadIndex(config(), 'conn1')).toBeUndefined();
  });

  it('round-trips a freshly saved index unchanged', async () => {
    const index: MetricIndex = {
      builtAt: new Date(0).toISOString(),
      dashboardsScanned: 3,
      entriesByMetric: {},
      brokenDatasources: [],
      alertBackedPanels: [
        { dashboardUid: 'd1', dashboardTitle: 'D1', panelId: 1, alertRules: [{ uid: 'r1', title: 'R1', labels: {} }] },
      ],
      dashboardMeta: { d1: { title: 'D1', updatedAt: '2024-01-01T00:00:00.000Z', updatedBy: 'alice' } },
    };
    await saveIndex(index, config(), 'conn1');
    expect(await loadIndex(config(), 'conn1')).toEqual(index);
  });

  it('backfills alertBackedPanels when reading a cache file written before that field existed (the real regression: a live crash on real stale cache files, see git history)', async () => {
    const legacyShape = {
      builtAt: new Date(0).toISOString(),
      dashboardsScanned: 3,
      entriesByMetric: {},
      brokenDatasources: [],
      // alertBackedPanels deliberately omitted, matching cache files written
      // before this field was added to MetricIndex.
    };
    const dir = join(dataDir, 'metric-index');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'conn1.json'), JSON.stringify(legacyShape), 'utf8');

    const loaded = await loadIndex(config(), 'conn1');
    expect(loaded?.alertBackedPanels).toEqual([]);
    // The exact pattern that crashed: flatMap-ing over alertBackedPanels
    // unconditionally, with no defensive default at the call site.
    expect(() => (loaded?.alertBackedPanels ?? []).map((p) => p.dashboardUid)).not.toThrow();
  });

  it('backfills dashboardMeta when reading a cache file written before that field existed', async () => {
    const legacyShape = {
      builtAt: new Date(0).toISOString(),
      dashboardsScanned: 1,
      entriesByMetric: {},
      brokenDatasources: [],
      alertBackedPanels: [],
      // dashboardMeta deliberately omitted, matching cache files written before this field was added.
    };
    const dir = join(dataDir, 'metric-index');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'conn1.json'), JSON.stringify(legacyShape), 'utf8');

    const loaded = await loadIndex(config(), 'conn1');
    expect(loaded?.dashboardMeta).toEqual({});
  });
});

describe('isStale', () => {
  const baseIndex: MetricIndex = {
    builtAt: new Date(0).toISOString(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    dashboardsScanned: 3,
    entriesByMetric: {},
    brokenDatasources: [],
    alertBackedPanels: [],
  };

  it('is not stale within the TTL when the schema version matches', () => {
    expect(isStale(baseIndex, 60_000, 30_000)).toBe(false);
  });

  it('is stale once the TTL elapses', () => {
    expect(isStale(baseIndex, 60_000, 120_000)).toBe(true);
  });

  // The real bug this guards against: a logic fix landed (getRuleGroups'
  // annotations were read from the wrong nesting level, silently emptying
  // alertBackedPanels for every real estate tested), but a same-shaped cache
  // file written by the old, buggy logic was still within its TTL — so the
  // fix had no visible effect until the cache happened to expire on its own.
  it('is unconditionally stale when the schema version is missing (pre-versioning cache), even within the TTL', () => {
    const legacy = { ...baseIndex, schemaVersion: undefined };
    expect(isStale(legacy, 60_000, 30_000)).toBe(true);
  });

  it('is unconditionally stale when the schema version is older than current, even within the TTL', () => {
    const older = { ...baseIndex, schemaVersion: CURRENT_SCHEMA_VERSION - 1 };
    expect(isStale(older, 60_000, 30_000)).toBe(true);
  });
});
