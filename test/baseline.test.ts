import { describe, expect, it } from 'vitest';
import { compareToBaseline, computeStats, detectOnset } from '../src/analysis/baseline.js';
import type { SeriesPoint } from '../src/query/executor.js';

function points(values: number[]): SeriesPoint[] {
  return values.map((v, i) => ({ t: i * 60_000, v }));
}

describe('computeStats', () => {
  it('computes mean/stddev/min/max, ignoring nulls', () => {
    const stats = computeStats([{ t: 0, v: 1 }, { t: 1, v: null }, { t: 2, v: 3 }]);
    expect(stats.count).toBe(2);
    expect(stats.mean).toBe(2);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(3);
  });

  it('returns NaN stats and count 0 for an empty series', () => {
    const stats = computeStats([]);
    expect(stats.count).toBe(0);
    expect(Number.isNaN(stats.mean)).toBe(true);
  });

  it('counts non-zero, non-null points separately from count', () => {
    const stats = computeStats([{ t: 0, v: 0 }, { t: 1, v: null }, { t: 2, v: 0 }, { t: 3, v: 5 }]);
    expect(stats.count).toBe(3);
    expect(stats.nonZeroCount).toBe(1);
  });
});

describe('compareToBaseline', () => {
  it('classifies a clear spike as statistically unusual', () => {
    const incident = points([100, 102, 98, 105]);
    const controls = [
      { label: 'prior-hour', points: points([10, 11, 9, 10]) },
      { label: 'same-hour-yesterday', points: points([9, 10, 11, 10]) },
    ];
    const result = compareToBaseline(incident, controls);
    expect(result.classification).toBe('statistically-unusual');
    expect(Math.abs(result.zScore)).toBeGreaterThan(3);
  });

  it('classifies similar magnitude as common during normal operations', () => {
    const incident = points([10, 11, 9, 10]);
    const controls = [
      { label: 'prior-hour', points: points([10, 11, 9, 10, 12, 8]) },
      { label: 'same-hour-yesterday', points: points([9, 10, 11, 10, 8, 12]) },
    ];
    const result = compareToBaseline(incident, controls);
    expect(result.classification).toBe('common-during-normal-operations');
  });

  it('reports insufficient-data when there is no baseline to compare against', () => {
    const result = compareToBaseline(points([1, 2, 3]), [{ label: 'prior-hour', points: [] }]);
    expect(result.classification).toBe('insufficient-data');
  });

  it('reports insufficient-data when the incident series itself is empty', () => {
    const result = compareToBaseline([], [{ label: 'prior-hour', points: points([1, 2, 3]) }]);
    expect(result.classification).toBe('insufficient-data');
    expect(result.briefExcursions).toEqual([]);
  });

  it('finds a brief excursion even when the window-mean classification calls it common (the diluted-mean case)', () => {
    // A near-constant health signal (1 = healthy) that's briefly fully down
    // for 3 points inside a 200-point window. The dip is real, but averaged
    // over the whole window it barely moves the mean.
    const values = Array.from({ length: 200 }, () => 1);
    values[100] = 0;
    values[101] = 0;
    values[102] = 0;
    const incident = points(values);
    const controls = [
      { label: 'prior-hour', points: points(Array.from({ length: 50 }, () => 1)) },
      { label: 'same-hour-yesterday', points: points(Array.from({ length: 50 }, () => 1)) },
    ];
    const result = compareToBaseline(incident, controls);

    expect(result.classification).toBe('common-during-normal-operations');
    expect(result.briefExcursions).toEqual([
      { startMs: 100 * 60_000, endMs: 102 * 60_000, durationMs: 2 * 60_000, minValue: 0, maxValue: 0, pointCount: 3 },
    ]);
  });

  it('reports no brief excursions when nothing deviates from the baseline', () => {
    const incident = points(Array.from({ length: 50 }, () => 1));
    const controls = [{ label: 'prior-hour', points: points(Array.from({ length: 50 }, () => 1)) }];
    const result = compareToBaseline(incident, controls);
    expect(result.briefExcursions).toEqual([]);
  });

  // The reported failure: one lone error against all-zero controls produced
  // zScore 1e8, classification 'statistically-unusual', and (via
  // summarize_findings) verdict 'real-anomaly' at 'high' confidence. An error
  // count legitimately 0 across every control window is the most common shape
  // for this class of metric.
  describe('all-zero baseline', () => {
    const allZeroControls = [
      { label: 'prior-hour', points: points(Array.from({ length: 10 }, () => 0)) },
      { label: 'same-hour-yesterday', points: points(Array.from({ length: 10 }, () => 0)) },
    ];

    it('classifies a single event against an all-zero baseline as a presence change, not 1e8 sigma', () => {
      const incident = points([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
      const result = compareToBaseline(incident, allZeroControls);

      expect(result.classification).toBe('baseline-all-zero');
      expect(Number.isNaN(result.zScore)).toBe(true);
      expect(result.classification).not.toBe('statistically-unusual');
    });

    it('still reports the nonzero point as a brief excursion', () => {
      // The useful signal for this shape: against an all-zero baseline the 2-sigma
      // bar reduces to "any nonzero point", which is the right question to ask.
      const result = compareToBaseline(points([0, 0, 0, 1]), allZeroControls);
      expect(result.briefExcursions.length).toBeGreaterThan(0);
    });

    it('treats an all-zero incident against an all-zero baseline as common, not a presence change', () => {
      const result = compareToBaseline(points([0, 0, 0, 0]), allZeroControls);
      expect(result.classification).toBe('common-during-normal-operations');
      expect(result.zScore).toBe(0);
    });

    it('does not fire for a nonzero baseline with zero variance (the 0.01*mean floor still applies)', () => {
      const steady = [{ label: 'prior-hour', points: points([5, 5, 5, 5]) }];
      const result = compareToBaseline(points([5, 5, 5, 5]), steady);
      expect(result.classification).toBe('common-during-normal-operations');
    });
  });

  it('pools between-window variance, not just within-window variance, when control means differ (seasonality)', () => {
    // Each control window is individually rock-steady (stddev 0), but the
    // three windows' means differ by day-of-week seasonality (10 / 20 / 30).
    // A pooled stddev that only averaged within-window variance would come
    // out to 0, making any incident value classify as infinitely unusual.
    const incident = points([20, 20, 20, 20]);
    const controls = [
      { label: 'prior-hour', points: points([10, 10, 10, 10]) },
      { label: 'same-hour-yesterday', points: points([20, 20, 20, 20]) },
      { label: 'same-hour-last-week', points: points([30, 30, 30, 30]) },
    ];
    const result = compareToBaseline(incident, controls);
    expect(result.pooledBaselineStddev).toBeGreaterThan(0);
    expect(result.classification).toBe('common-during-normal-operations');
  });
});

describe('detectOnset', () => {
  it('finds the first point that deviates beyond the threshold from baseline', () => {
    const baseline = computeStats(points([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]));
    const incident = points([10, 10, 50, 51]);
    const onset = detectOnset(incident, baseline, 2);
    expect(onset).toBe(2 * 60_000);
  });

  it('returns undefined when nothing deviates', () => {
    const baseline = computeStats(points([10, 11, 9, 10, 11, 9, 10, 11, 9, 10]));
    const onset = detectOnset(points([10, 11, 10]), baseline, 2);
    expect(onset).toBeUndefined();
  });
});
