import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadIndex, saveIndex, type MetricIndex } from '../src/index-builder/store.js';
import type { Config } from '../src/config.js';

let dataDir: string;

function config(): Config {
  return {
    connections: [],
    tlsVerify: true,
    requestTimeoutMs: 1000,
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
});
