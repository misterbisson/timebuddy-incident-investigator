import type { SeriesPoint } from '../query/executor.js';

export interface ThresholdRun {
  /** Timestamp of the first sample in the run. */
  startMs: number;
  /**
   * Timestamp of the *last* sample in the run — the instant of that sample,
   * not the end of its bucket. The excursion continues for however wide that
   * final sample's bucket is (at least one sample interval past endMs), which
   * this function has no way to know: it only sees sample timestamps.
   */
  endMs: number;
  /**
   * endMs - startMs: the span from the first crossing sample to the last, NOT
   * a bucket-aware outage length. Consequences worth knowing before reporting
   * this as a duration:
   *   - A run of a single sample has startMs === endMs, so durationMs === 0.
   *     A one-minute outage caught in one 60s-resolution sample reads as 0 ms,
   *     which is not "instantaneous" — it's "one bucket wide, and we can't see
   *     the bucket from here."
   *   - Every run understates the true duration by up to one sample interval,
   *     because the final sample's own bucket isn't counted.
   * This is deliberate (see issue #67): rather than guess a bucket width from
   * the median gap between points and bake it into a single number, the raw
   * sample span is returned and consumers that need an outage length read it
   * together with pointCount and the series' sample spacing. The tool
   * descriptions for execute_query_window / validate_baseline say the same.
   */
  durationMs: number;
  minValue: number;
  maxValue: number;
  pointCount: number;
}

/**
 * Finds maximal runs of consecutive non-null points crossing a threshold —
 * e.g. an uptime-style metric (1.0 = fully up) dropping below 1.0, or an
 * error-rate metric rising above some percentage. This is the exact "find
 * where a series dipped and get the precise start/end" analysis an agent
 * would otherwise have to write ad hoc jq/python for against a saved tool
 * result; doing it here means one execute_query_window call answers it.
 */
export function findThresholdRuns(
  points: SeriesPoint[],
  threshold: number,
  direction: 'below' | 'above' = 'below',
): ThresholdRun[] {
  const matches = (v: number) => (direction === 'below' ? v < threshold : v > threshold);
  const runs: ThresholdRun[] = [];
  let current: SeriesPoint[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const values = current.map((p) => p.v as number);
    const first = current[0]!;
    const last = current[current.length - 1]!;
    runs.push({
      startMs: first.t,
      endMs: last.t,
      durationMs: last.t - first.t,
      minValue: Math.min(...values),
      maxValue: Math.max(...values),
      pointCount: current.length,
    });
    current = [];
  };

  for (const p of points) {
    if (p.v !== null && matches(p.v)) {
      current.push(p);
    } else {
      flush();
    }
  }
  flush();

  return runs;
}
