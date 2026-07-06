import type { SeriesPoint } from '../query/executor.js';

export interface SeriesStats {
  mean: number;
  stddev: number;
  min: number;
  max: number;
  count: number;
}

export function computeStats(points: SeriesPoint[]): SeriesStats {
  const values = points.map((p) => p.v).filter((v): v is number => v !== null && Number.isFinite(v));
  if (values.length === 0) {
    return { mean: NaN, stddev: NaN, min: NaN, max: NaN, count: 0 };
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, stddev: Math.sqrt(variance), min: Math.min(...values), max: Math.max(...values), count: values.length };
}

export type BaselineClassification = 'statistically-unusual' | 'common-during-normal-operations' | 'insufficient-data';

export interface BaselineComparison {
  incidentStats: SeriesStats;
  controlStats: Array<{ label: string; stats: SeriesStats }>;
  pooledBaselineMean: number;
  pooledBaselineStddev: number;
  zScore: number;
  classification: BaselineClassification;
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
    };
  }

  const pooledBaselineMean = validControls.reduce((a, c) => a + c.stats.mean, 0) / validControls.length;
  const pooledBaselineStddev =
    Math.sqrt(validControls.reduce((a, c) => a + c.stats.stddev ** 2, 0) / validControls.length) || 0;
  const effectiveStddev = pooledBaselineStddev || Math.abs(pooledBaselineMean) * 0.01 || 1e-9;
  const zScore = (incidentStats.mean - pooledBaselineMean) / effectiveStddev;

  return {
    incidentStats,
    controlStats,
    pooledBaselineMean,
    pooledBaselineStddev,
    zScore,
    classification: Math.abs(zScore) >= zThreshold ? 'statistically-unusual' : 'common-during-normal-operations',
  };
}

/** First timestamp where a series deviates more than thresholdSigma from a baseline's mean. */
export function detectOnset(points: SeriesPoint[], baseline: SeriesStats, thresholdSigma = 2): number | undefined {
  if (!Number.isFinite(baseline.mean) || !Number.isFinite(baseline.stddev)) return undefined;
  const stddev = baseline.stddev || Math.abs(baseline.mean) * 0.01 || 1e-9;
  for (const point of points) {
    if (point.v === null) continue;
    if (Math.abs(point.v - baseline.mean) / stddev >= thresholdSigma) return point.t;
  }
  return undefined;
}
