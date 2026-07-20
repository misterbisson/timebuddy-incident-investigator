import type { SeriesPoint } from '../query/executor.js';
import { findThresholdRuns, type ThresholdRun } from './runs.js';

export interface SeriesStats {
  mean: number;
  stddev: number;
  min: number;
  max: number;
  count: number;
  /** Non-null points with a non-zero value — answers "was there any activity at all" without a threshold call. */
  nonZeroCount: number;
}

export function computeStats(points: SeriesPoint[]): SeriesStats {
  const values = points.map((p) => p.v).filter((v): v is number => v !== null && Number.isFinite(v));
  if (values.length === 0) {
    return { mean: NaN, stddev: NaN, min: NaN, max: NaN, count: 0, nonZeroCount: 0 };
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return {
    mean,
    stddev: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
    count: values.length,
    nonZeroCount: values.filter((v) => v !== 0).length,
  };
}

/**
 * A baseline stddev is often exactly 0 for a near-constant signal (e.g. a
 * health status pinned at 1) — dividing by that directly would blow up to
 * infinity for any deviation at all, so fall back to a small fraction of
 * the mean, then an absolute epsilon, as a floor for "how much deviation
 * actually matters" rather than a literal zero-division guard.
 */
function effectiveStddev(mean: number, stddev: number): number {
  return stddev || Math.abs(mean) * 0.01 || 1e-9;
}

export type BaselineClassification =
  | 'statistically-unusual'
  | 'common-during-normal-operations'
  | 'insufficient-data'
  /**
   * Every control window was flat zero and the incident window wasn't: a
   * presence change rather than a deviation. `zScore` is NaN for this — a
   * z-score needs spread to be meaningful, and there is none. Judge it on
   * `incidentStats` magnitude plus corroboration (threshold crossing,
   * correlated signals), not on sigma.
   *
   * NaN in process, but `null` once it reaches the model: JSON has no NaN, so
   * `JSON.stringify` emits null (the same round-trip `tools/summarizeFindings.ts`
   * handles with `nullableNumber`/`toNaN`). Agent-facing text — this tool's
   * description and the investigate skill — says null for that reason.
   */
  | 'baseline-all-zero';

export interface BaselineComparison {
  incidentStats: SeriesStats;
  controlStats: Array<{ label: string; stats: SeriesStats }>;
  pooledBaselineMean: number;
  pooledBaselineStddev: number;
  zScore: number;
  classification: BaselineClassification;
  /**
   * Sharp, brief deviations from the baseline mean, found point-by-point —
   * independent of `classification` above. A window-mean z-score dilutes a
   * short, real event inside a long analysis window (averaging is the wrong
   * operation for "did something briefly go to zero"), so a series can
   * legitimately classify as "common-during-normal-operations" while still
   * having a real excursion here. Always check this, not just the
   * classification, before calling something routine.
   */
  briefExcursions: ThresholdRun[];
}

/**
 * Compares the incident window's stats against a pool of control (baseline)
 * windows via a z-score. Pooling multiple control windows (prior hour,
 * same-hour-yesterday, same-hour-last-week, ...) means a single unusual
 * baseline window can't itself look like an anomaly.
 */
export function compareToBaseline(
  incidentPoints: SeriesPoint[],
  controlWindows: Array<{ label: string; points: SeriesPoint[] }>,
  zThreshold = 3,
): BaselineComparison {
  const incidentStats = computeStats(incidentPoints);
  const controlStats = controlWindows.map((c) => ({ label: c.label, stats: computeStats(c.points) }));
  const validControls = controlStats.filter((c) => c.stats.count > 0);

  if (incidentStats.count === 0 || validControls.length === 0) {
    return {
      incidentStats,
      controlStats,
      pooledBaselineMean: NaN,
      pooledBaselineStddev: NaN,
      zScore: NaN,
      classification: 'insufficient-data',
      briefExcursions: [],
    };
  }

  const pooledBaselineMean = validControls.reduce((a, c) => a + c.stats.mean, 0) / validControls.length;
  // Law of total variance: the pooled spread must include how much control
  // *means* vary from each other (e.g. day-of-week seasonality across
  // prior-hour/yesterday/last-week), not just each window's own internal
  // variance — averaging only within-window stddevs understates the true
  // baseline spread and biases toward false "statistically-unusual" verdicts.
  const withinVariance = validControls.reduce((a, c) => a + c.stats.stddev ** 2, 0) / validControls.length;
  const betweenVariance =
    validControls.reduce((a, c) => a + (c.stats.mean - pooledBaselineMean) ** 2, 0) / validControls.length;
  const pooledBaselineStddev = Math.sqrt(withinVariance + betweenVariance) || 0;
  const stddev = effectiveStddev(pooledBaselineMean, pooledBaselineStddev);
  const zScore = (incidentStats.mean - pooledBaselineMean) / stddev;

  // Point-level companion to the mean-based z-score above, using the same
  // baseline and a fixed, more sensitive 2-sigma bar (not the caller's
  // zThreshold) deliberately, so it catches what the headline classification
  // might dilute away rather than requiring the same strict bar to agree.
  const briefExcursions = [
    ...findThresholdRuns(incidentPoints, pooledBaselineMean - 2 * stddev, 'below'),
    ...findThresholdRuns(incidentPoints, pooledBaselineMean + 2 * stddev, 'above'),
  ].sort((a, b) => a.startMs - b.startMs);

  // A baseline that is flat zero across every control window carries no scale:
  // effectiveStddev falls through to its 1e-9 epsilon, and any nonzero incident
  // value divided by that is ~1e8 "sigma". That number is noise wearing the
  // costume of precision — it says nothing about how unusual the event is,
  // because there is no spread to be unusual relative to. An error count that
  // is legitimately 0 across every control window is the most common shape for
  // this class of metric, so this is exactly where a false "maximally
  // confident anomaly" would be generated.
  //
  // What actually happened is a *presence* change: something that never
  // occurred in any baseline window occurred in this one. That's reported as
  // its own classification, with no z-score, and callers weigh it on magnitude
  // and corroboration instead (see analysis/summarize.ts). briefExcursions
  // still works and is the useful signal here — against an all-zero baseline
  // its 2-sigma bar reduces to "any nonzero point", which is the right
  // question for this shape.
  //
  // An all-zero incident against an all-zero baseline is not a presence change
  // at all; it falls through to the normal path, where it scores 0 and reads
  // as common, which is correct.
  if (pooledBaselineMean === 0 && pooledBaselineStddev === 0 && incidentStats.nonZeroCount > 0) {
    return {
      incidentStats,
      controlStats,
      pooledBaselineMean,
      pooledBaselineStddev,
      zScore: NaN,
      classification: 'baseline-all-zero',
      briefExcursions,
    };
  }

  return {
    incidentStats,
    controlStats,
    pooledBaselineMean,
    pooledBaselineStddev,
    zScore,
    classification: Math.abs(zScore) >= zThreshold ? 'statistically-unusual' : 'common-during-normal-operations',
    briefExcursions,
  };
}

/** First timestamp where a series deviates more than thresholdSigma from a baseline's mean. */
export function detectOnset(points: SeriesPoint[], baseline: SeriesStats, thresholdSigma = 2): number | undefined {
  if (!Number.isFinite(baseline.mean) || !Number.isFinite(baseline.stddev)) return undefined;
  const stddev = effectiveStddev(baseline.mean, baseline.stddev);
  for (const point of points) {
    if (point.v === null) continue;
    if (Math.abs(point.v - baseline.mean) / stddev >= thresholdSigma) return point.t;
  }
  return undefined;
}
