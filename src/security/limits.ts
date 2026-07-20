import type { Config } from '../config.js';
import type { TimeWindow } from '../query/windows.js';
import type { QuerySeries, SeriesPoint } from '../query/executor.js';

export class LimitExceededError extends Error {}

/** Rejects windows wider than the configured max lookback (protects against runaway queries). */
export function enforceWindowLimit(window: TimeWindow, config: Config): void {
  const spanHours = (window.toMs - window.fromMs) / 3_600_000;
  if (spanHours > config.maxLookbackHours) {
    throw new LimitExceededError(
      `Requested window "${window.label}" spans ${spanHours.toFixed(1)}h, exceeding MAX_LOOKBACK_HOURS=${config.maxLookbackHours}`,
    );
  }
  if (window.toMs <= window.fromMs) {
    throw new LimitExceededError(`Window "${window.label}" has a non-positive duration`);
  }
}

/** Caps maxDataPoints so a single query can't request an unbounded number of samples. */
export function clampMaxDataPoints(requested: number | undefined, config: Config): number {
  if (!requested) return config.maxDataPoints;
  return Math.min(requested, config.maxDataPoints);
}

/**
 * Hard backstop on returned series: the `maxDataPoints` sent to /api/ds/query is only a hint,
 * and datasources that don't time-bucket the query themselves (e.g. raw InfluxQL with no
 * `GROUP BY time(...)`) can ignore it and return every raw point. Without this, a single
 * high-frequency series over a multi-hour window (x5 for incident/pre-window/controls) can
 * balloon a tool response into tens of megabytes, which is large enough to break the MCP
 * connection rather than just being slow. Downsamples with a uniform stride, always keeping
 * the last point so the window's end boundary stays exact; `pointsTotal` reports the
 * untruncated count so callers can tell downsampling happened.
 *
 * Apply this where points are *emitted* to the model, not at the query boundary: every
 * analysis in analysis/ reads the same series and needs it at full resolution (see the note
 * in query/executor.ts).
 */
export function clampSeriesPoints(series: QuerySeries[], config: Config): QuerySeries[] {
  return series.map((s) => {
    const pointsTotal = s.points.length;
    if (pointsTotal <= config.maxDataPoints) {
      return { ...s, pointsTotal };
    }
    const stride = pointsTotal / config.maxDataPoints;
    const points: SeriesPoint[] = [];
    for (let i = 0; i < config.maxDataPoints - 1; i++) {
      points.push(s.points[Math.floor(i * stride)]!);
    }
    points.push(s.points[pointsTotal - 1]!);
    return { ...s, points, pointsTotal };
  });
}

/**
 * Companion cap for the run/excursion lists derived from a series. Those are
 * emitted as arrays too, and their length is bounded by the number of threshold
 * *crossings* rather than by clampSeriesPoints — a noisy signal hovering right
 * at the bar can cross on nearly every sample. While analyses ran on already-
 * downsampled points this was incidentally capped at maxDataPoints/2; now that
 * they see the full series (which is the point of that change — short runs were
 * being missed), it needs its own bound.
 *
 * Generous on purpose: any real incident's run list is orders of magnitude
 * under this, so hitting it means the series is pathological, and the total is
 * reported alongside so a truncated list never reads as a complete one.
 */
export const MAX_RETURNED_RUNS = 1000;

export function clampRunList<T>(runs: T[]): { list: T[]; total: number; truncated: boolean } {
  if (runs.length <= MAX_RETURNED_RUNS) return { list: runs, total: runs.length, truncated: false };
  return { list: runs.slice(0, MAX_RETURNED_RUNS), total: runs.length, truncated: true };
}
