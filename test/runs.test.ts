import { describe, expect, it } from 'vitest';
import { findThresholdRuns } from '../src/analysis/runs.js';
import type { SeriesPoint } from '../src/query/executor.js';

function pts(values: Array<number | null>, stepMs = 60_000, startMs = 0): SeriesPoint[] {
  return values.map((v, i) => ({ t: startMs + i * stepMs, v }));
}

describe('findThresholdRuns', () => {
  it('finds a single contiguous run below the threshold', () => {
    const runs = findThresholdRuns(pts([1, 1, 0.5, 0.2, 0.9, 1, 1]), 1, 'below');
    expect(runs).toEqual([
      { startMs: 120_000, endMs: 240_000, durationMs: 120_000, minValue: 0.2, maxValue: 0.9, pointCount: 3 },
    ]);
  });

  it('finds multiple separate runs', () => {
    const runs = findThresholdRuns(pts([1, 0.5, 1, 1, 0.3, 0.4, 1]), 1, 'below');
    expect(runs).toHaveLength(2);
    expect(runs[0]?.pointCount).toBe(1);
    expect(runs[1]?.pointCount).toBe(2);
  });

  it('returns no runs when nothing crosses the threshold', () => {
    expect(findThresholdRuns(pts([1, 1, 1]), 1, 'below')).toEqual([]);
  });

  it('treats null points as breaking a run, not part of it', () => {
    const runs = findThresholdRuns(pts([0.5, null, 0.5]), 1, 'below');
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.pointCount === 1)).toBe(true);
  });

  it('supports "above" direction for spike detection', () => {
    const runs = findThresholdRuns(pts([1, 5, 6, 1]), 3, 'above');
    expect(runs).toEqual([{ startMs: 60_000, endMs: 120_000, durationMs: 60_000, minValue: 5, maxValue: 6, pointCount: 2 }]);
  });
});
