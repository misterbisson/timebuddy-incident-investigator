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

  describe('all-zero baseline (presence change)', () => {
    // The end-to-end shape of the reported bug: one error event against
    // all-zero controls, thresholdCrossed true, which previously rendered as
    // "deviates 100000000.0σ from the pooled baseline" at high confidence.
    const oneEventStats: SeriesStats = { mean: 0.1, stddev: 0.3, min: 0, max: 1, count: 10, nonZeroCount: 1 };
    const zeroStats: SeriesStats = { mean: 0, stddev: 0, min: 0, max: 0, count: 10, nonZeroCount: 0 };

    function presenceInput(): SummarizeFindingsInput {
      return baseInput({
        incidentStats: oneEventStats,
        controlStats: [{ label: 'prior-hour', stats: zeroStats }, { label: 'same-hour-yesterday', stats: zeroStats }],
        pooledBaselineMean: 0,
        pooledBaselineStddev: 0,
        zScore: NaN,
        classification: 'baseline-all-zero',
      });
    }

    it('never reports high confidence, even with the threshold crossed', () => {
      const input = presenceInput();
      input.thresholdCrossed = true;
      const report = summarizeFindings(input);
      expect(report.confidence).not.toBe('high');
      expect(report.confidence).toBe('medium');
    });

    it('describes magnitude rather than a sigma figure', () => {
      const input = presenceInput();
      input.thresholdCrossed = true;
      const joined = summarizeFindings(input).reasons.join(' ');
      expect(joined).not.toMatch(/σ/);
      expect(joined).toMatch(/presence change/);
      expect(joined).toMatch(/1 nonzero sample\(s\) of 10/);
    });

    it('is inconclusive and low confidence with no corroboration at all', () => {
      const report = summarizeFindings(presenceInput());
      expect(report.verdict).toBe('inconclusive');
      expect(report.confidence).toBe('low');
    });

    it('flags the missing statistical comparison when the threshold did not cross', () => {
      const report = summarizeFindings(presenceInput());
      expect(report.missingData.join(' ')).toMatch(/Baseline was all zeros/);
    });

    // Every other assertion here checks the in-process object, where the value
    // is NaN — so none of them can catch the wire representation drifting from
    // what the tool description and skill tell the agent to expect. JSON has no
    // NaN, so what actually reaches the model is null.
    it('serializes zScore to null, which is what agent-facing docs promise', () => {
      const input = presenceInput();
      input.thresholdCrossed = true;
      const wire = JSON.parse(JSON.stringify(summarizeFindings(input)));
      expect(wire.triggeredSignal.zScore).toBeNull();
      // null here means "not applicable", and must not be confused with 0.
      expect(wire.triggeredSignal.zScore).not.toBe(0);
      expect(wire.triggeredSignal.classification).toBe('baseline-all-zero');
    });

    it('carries the NaN zScore through without rendering it as a number', () => {
      const input = presenceInput();
      input.thresholdCrossed = true;
      const report = summarizeFindings(input);
      expect(Number.isNaN(report.triggeredSignal.zScore)).toBe(true);
      expect(report.triggeredSignal.classification).toBe('baseline-all-zero');
    });
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
