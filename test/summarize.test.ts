import { describe, expect, it } from 'vitest';
import { summarizeFindings, type SummarizeFindingsInput } from '../src/analysis/summarize.js';
import type { SeriesStats } from '../src/analysis/baseline.js';
import type { ThresholdRun } from '../src/analysis/runs.js';

const okStats: SeriesStats = { mean: 1, stddev: 0.01, min: 0.9, max: 1, count: 100, nonZeroCount: 100 };

function baseInput(overrides: Partial<SummarizeFindingsInput['baseline']> = {}): SummarizeFindingsInput {
  return {
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
      briefExcursions: [],
      ...overrides,
    },
  };
}

function excursion(): ThresholdRun {
  return { startMs: 1000, endMs: 2000, durationMs: 1000, minValue: 0.1, maxValue: 0.3, pointCount: 3 };
}

describe('summarizeFindings', () => {
  it('returns real-anomaly when the whole-window classification is statistically unusual and the threshold crossed', () => {
    const input = baseInput({ classification: 'statistically-unusual', zScore: -8 });
    input.thresholdCrossed = true;
    const report = summarizeFindings(input);
    expect(report.verdict).toBe('real-anomaly');
    expect(report.confidence).toBe('high');
  });

  it('returns likely-false-positive when the classification is common and there are no brief excursions', () => {
    const report = summarizeFindings(baseInput());
    expect(report.verdict).toBe('likely-false-positive');
    expect(report.likelyScope).toBe('none');
  });

  it('never returns likely-false-positive when brief excursions are present, even though the whole-window mean looks common', () => {
    const input = baseInput({ briefExcursions: [excursion()] });
    const report = summarizeFindings(input);
    expect(report.verdict).toBe('inconclusive');
    expect(report.confidence).toBe('low');
    expect(report.reasons.some((r) => r.includes('brief excursion'))).toBe(true);
  });

  it('adds a corroborating reason for brief excursions alongside an already-real-anomaly verdict', () => {
    const input = baseInput({ classification: 'statistically-unusual', zScore: -8, briefExcursions: [excursion(), excursion()] });
    input.thresholdCrossed = true;
    const report = summarizeFindings(input);
    expect(report.verdict).toBe('real-anomaly');
    expect(report.reasons.some((r) => r.includes('2 brief excursion'))).toBe(true);
  });

  it('returns inconclusive for insufficient-data regardless of brief excursions', () => {
    const input = baseInput({ classification: 'insufficient-data', briefExcursions: [excursion()] });
    const report = summarizeFindings(input);
    expect(report.verdict).toBe('inconclusive');
    expect(report.confidence).toBe('low');
  });

  it('returns inconclusive when statistically unusual but the alert threshold was not crossed', () => {
    const input = baseInput({ classification: 'statistically-unusual', zScore: -4 });
    input.thresholdCrossed = false;
    const report = summarizeFindings(input);
    expect(report.verdict).toBe('inconclusive');
  });
});
