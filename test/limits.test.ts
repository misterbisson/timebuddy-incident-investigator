import { describe, expect, it } from 'vitest';
import { clampScreenshotDimension, clampSeriesPoints, MAX_SCREENSHOT_PX, MIN_SCREENSHOT_PX } from '../src/security/limits.js';
import type { Config } from '../src/config.js';
import type { QuerySeries } from '../src/query/executor.js';

const config: Config = {
  connections: [],
  tlsVerify: true,
  requestTimeoutMs: 1000,
  screenshotTimeoutMs: 45000,
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

describe('clampScreenshotDimension', () => {
  it('leaves an in-bounds value untouched and reports no clamp', () => {
    expect(clampScreenshotDimension(1600, 1600)).toEqual({ value: 1600, clamped: false });
  });

  it('clamps above the ceiling and below the floor', () => {
    expect(clampScreenshotDimension(100_000, 1600)).toEqual({ value: MAX_SCREENSHOT_PX, clamped: true });
    expect(clampScreenshotDimension(-1, 1600)).toEqual({ value: MIN_SCREENSHOT_PX, clamped: true });
  });

  it('accepts the bounds themselves without reporting a clamp', () => {
    expect(clampScreenshotDimension(MAX_SCREENSHOT_PX, 1600).clamped).toBe(false);
    expect(clampScreenshotDimension(MIN_SCREENSHOT_PX, 1600).clamped).toBe(false);
  });

  it('rounds fractional pixels, and counts the rounding as a clamp', () => {
    expect(clampScreenshotDimension(1600.5, 1600)).toEqual({ value: 1601, clamped: true });
  });

  it('resolves a non-finite request to the fallback, never to a bound', () => {
    expect(clampScreenshotDimension(Number.NaN, 900).value).toBe(900);
    expect(clampScreenshotDimension(Number.POSITIVE_INFINITY, 900).value).toBe(900);
    expect(clampScreenshotDimension(undefined as unknown as number, 900).value).toBe(900);
  });

  it('still bounds a fallback that is itself out of range', () => {
    expect(clampScreenshotDimension(Number.NaN, 999_999).value).toBe(MAX_SCREENSHOT_PX);
  });
});
