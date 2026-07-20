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

describe('screenshot dimension bounds', () => {
  // Pinned to literals on purpose. Every other assertion in this file compares
  // clampScreenshotDimension's output against the imported constants, so both
  // sides move together and the assertions are near-tautological: widening
  // MAX_SCREENSHOT_PX to 50000 and MIN to 1 passed the entire suite while
  // fully reinstating #73's OOM (50000x50000 is 2.5e9 px). These two lines are
  // what make the rest of the file mean anything.
  it('are the values this guard was sized for', () => {
    expect(MAX_SCREENSHOT_PX).toBe(3840);
    expect(MIN_SCREENSHOT_PX).toBe(200);
  });

  // Independent of the constants entirely, so a future retune has to stay
  // inside something defensible rather than silently unbounding the guard.
  it('keep any request inside a sane absolute range, whatever the constants become', () => {
    expect(clampScreenshotDimension(1e9, 1600).value).toBeLessThanOrEqual(4000);
    expect(clampScreenshotDimension(1e9, 1600).value * clampScreenshotDimension(1e9, 900).value)
      .toBeLessThanOrEqual(16_000_000);
    expect(clampScreenshotDimension(0, 1600).value).toBeGreaterThan(0);
    expect(clampScreenshotDimension(-1e9, 1600).value).toBeGreaterThan(0);
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

});

describe('clampScreenshotDimension fallback vs clamp', () => {
  // `clamped` drives a user-facing warning, so conflating "you asked for
  // something out of range" with "you asked for nothing" produced the nonsense
  // "Requested undefinedxundefined was clamped to 1600x900" on the plain
  // defaults path.
  it('does not report a clamp when it simply fell back', () => {
    expect(clampScreenshotDimension(undefined as unknown as number, 1600)).toEqual({ value: 1600, clamped: false });
    expect(clampScreenshotDimension(Number.NaN, 900)).toEqual({ value: 900, clamped: false });
    expect(clampScreenshotDimension(Number.POSITIVE_INFINITY, 900)).toEqual({ value: 900, clamped: false });
  });

  // Still bounded, but reported as no clamp: `clamped` is relative to what the
  // *caller asked for*, and here they asked for nothing. Warning "your request
  // was clamped" about a request that was never made would be the same
  // nonsense in a different place. The safety property is unaffected — the
  // value is bounded either way — and the tool's own defaults are always in
  // range, so this only arises if a caller passes a bad fallback.
  it('bounds an out-of-range fallback without calling it a clamp', () => {
    expect(clampScreenshotDimension(Number.NaN, 999_999)).toEqual({ value: MAX_SCREENSHOT_PX, clamped: false });
  });
});
