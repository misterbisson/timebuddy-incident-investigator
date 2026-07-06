import type { SeriesPoint } from '../query/executor.js';

export interface ThresholdRun {
  startMs: number;
  endMs: number;
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
