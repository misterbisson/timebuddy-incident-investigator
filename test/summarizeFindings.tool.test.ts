import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerSummarizeFindings } from '../src/tools/summarizeFindings.js';
import type { Config } from '../src/config.js';
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

const okStats = { mean: 1, stddev: 0.01, min: 0.9, max: 1, count: 100, nonZeroCount: 100 };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'summarize-findings-tool-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('summarize_findings tool', () => {
  it('carries validate_baseline\'s briefExcursions through to the verdict, instead of dropping it', async () => {
    const { server, call } = fakeServer();
    registerSummarizeFindings(server, { config: config() } as never);

    const result = (await call('summarize_findings', {
      labels: {},
      correlated: [],
      evidence: [],
      warnings: [],
      baseline: {
        incidentStats: okStats,
        controlStats: [{ label: 'prior-hour', stats: okStats }],
        pooledBaselineMean: 1,
        pooledBaselineStddev: 0.01,
        zScore: 0,
        classification: 'common-during-normal-operations',
        briefExcursions: [{ startMs: 1000, endMs: 2000, durationMs: 1000, minValue: 0.1, maxValue: 0.3, pointCount: 3 }],
      },
    })) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.verdict).toBe('inconclusive');
    expect(parsed.reasons.some((r: string) => r.includes('brief excursion'))).toBe(true);
  });

  it('defaults briefExcursions to empty when omitted, preserving prior behavior', async () => {
    const { server, call } = fakeServer();
    registerSummarizeFindings(server, { config: config() } as never);

    const result = (await call('summarize_findings', {
      labels: {},
      correlated: [],
      evidence: [],
      warnings: [],
      baseline: {
        incidentStats: okStats,
        controlStats: [{ label: 'prior-hour', stats: okStats }],
        pooledBaselineMean: 1,
        pooledBaselineStddev: 0.01,
        zScore: 0,
        classification: 'common-during-normal-operations',
      },
    })) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.verdict).toBe('likely-false-positive');
  });
});
