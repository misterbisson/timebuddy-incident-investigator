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

  // durationMs is the span between the first and last crossing *sample*, not a
  // bucket-aware outage length — so a single-sample run is 0 ms by design, and
  // an N-sample run is (N-1) intervals, one interval short of the real outage.
  // Pinned intentionally (issue #67): the tool descriptions and the investigate
  // skill tell callers to read durationMs with pointCount and sample spacing
  // rather than as an exact length, and this asserts the semantics they rely on.
  it('measures durationMs as the raw first-to-last-sample span', () => {
    // Single crossing sample: no measurable span between one point and itself.
    const [single] = findThresholdRuns(pts([1, 0.5, 1]), 1, 'below');
    expect(single).toMatchObject({ startMs: 60_000, endMs: 60_000, durationMs: 0, pointCount: 1 });

    // Three consecutive 60s samples span two intervals (120s), not the ~180s
    // the three buckets actually cover — the last sample's bucket isn't counted.
    const [multi] = findThresholdRuns(pts([1, 0.2, 0.3, 0.2, 1]), 1, 'below');
    expect(multi).toMatchObject({ durationMs: 120_000, pointCount: 3 });
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
