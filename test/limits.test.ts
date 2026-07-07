import { describe, expect, it } from 'vitest';
import { clampSeriesPoints } from '../src/security/limits.js';
import type { Config } from '../src/config.js';
import type { QuerySeries } from '../src/query/executor.js';

const config: Config = {
  connections: [],
  tlsVerify: true,
  requestTimeoutMs: 1000,
  maxConcurrency: 4,
  maxLookbackHours: 720,
  maxDataPoints: 5,
  redactionPatterns: [],
  dataDir: '.data',
  webhookPort: 4318,
};

function series(pointCount: number): QuerySeries {
  const points = Array.from({ length: pointCount }, (_, i) => ({ t: i * 1000, v: i }));
  return { refId: 'A', labels: {}, points, pointsTotal: points.length };
}

describe('clampSeriesPoints', () => {
  it('passes series at or under the limit through unchanged', () => {
    const [result] = clampSeriesPoints([series(5)], config);
    expect(result?.points).toHaveLength(5);
    expect(result?.pointsTotal).toBe(5);
  });

  it('downsamples a series that ignored the maxDataPoints hint, reporting the untruncated count', () => {
    const [result] = clampSeriesPoints([series(1000)], config);
    expect(result?.points).toHaveLength(5);
    expect(result?.pointsTotal).toBe(1000);
  });

  it('always keeps the last point, so the window end boundary stays exact', () => {
    const [result] = clampSeriesPoints([series(1000)], config);
    expect(result?.points.at(-1)).toEqual({ t: 999_000, v: 999 });
  });

  it('keeps points in chronological order after downsampling', () => {
    const [result] = clampSeriesPoints([series(1000)], config);
    const times = result?.points.map((p) => p.t) ?? [];
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
