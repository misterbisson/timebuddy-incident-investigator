import { describe, expect, it } from 'vitest';
import { computeWindows, excludeOverlapping, windowsOverlap } from '../src/query/windows.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe('computeWindows', () => {
  it('builds an incident window, pre-window buffer, and default control windows', () => {
    const startsAtMs = 1_700_000_000_000;
    const endsAtMs = startsAtMs + 10 * 60_000;
    const result = computeWindows({ startsAtMs, endsAtMs });

    expect(result.incident).toEqual({ label: 'incident', fromMs: startsAtMs, toMs: endsAtMs });
    expect(result.preWindow.toMs).toBe(startsAtMs);
    expect(result.preWindow.fromMs).toBe(startsAtMs - 30 * 60_000); // default floor of 30min

    const labels = result.controls.map((c) => c.label);
    expect(labels).toEqual(['prior-hour', 'same-hour-yesterday', 'same-hour-last-week']);
    const priorHour = result.controls.find((c) => c.label === 'prior-hour')!;
    expect(priorHour.fromMs).toBe(startsAtMs - HOUR);
    expect(priorHour.toMs).toBe(endsAtMs - HOUR);
    const lastWeek = result.controls.find((c) => c.label === 'same-hour-last-week')!;
    expect(lastWeek.fromMs).toBe(startsAtMs - WEEK);
  });

  it('defaults endsAtMs to now for a still-firing alert', () => {
    const startsAtMs = 1_700_000_000_000;
    const nowMs = startsAtMs + 5 * 60_000;
    const result = computeWindows({ startsAtMs, nowMs });
    expect(result.incident.toMs).toBe(nowMs);
  });

  it('uses incident duration as the pre-window size when longer than the 30min floor', () => {
    const startsAtMs = 1_700_000_000_000;
    const endsAtMs = startsAtMs + 2 * HOUR;
    const result = computeWindows({ startsAtMs, endsAtMs });
    expect(result.preWindow.fromMs).toBe(startsAtMs - 2 * HOUR);
  });

  it('supports empty controlOffsets to skip baseline windows', () => {
    const result = computeWindows({ startsAtMs: 1_700_000_000_000, endsAtMs: 1_700_000_600_000, controlOffsets: [] });
    expect(result.controls).toEqual([]);
  });

  it('rejects an end time before the start time', () => {
    expect(() => computeWindows({ startsAtMs: 1000, endsAtMs: 500 })).toThrow();
  });

  it('produces a prior-hour control that overlaps the incident when the incident is longer than 1h', () => {
    const startsAtMs = 1_700_000_000_000;
    const endsAtMs = startsAtMs + 5.5 * HOUR;
    const result = computeWindows({ startsAtMs, endsAtMs });
    const priorHour = result.controls.find((c) => c.label === 'prior-hour')!;
    expect(windowsOverlap(result.incident, priorHour)).toBe(true);
  });
});

describe('windowsOverlap', () => {
  it('detects overlap when windows intersect', () => {
    expect(windowsOverlap({ label: 'a', fromMs: 0, toMs: 100 }, { label: 'b', fromMs: 50, toMs: 150 })).toBe(true);
  });

  it('does not consider adjacent (touching) windows overlapping', () => {
    expect(windowsOverlap({ label: 'a', fromMs: 0, toMs: 100 }, { label: 'b', fromMs: 100, toMs: 200 })).toBe(false);
  });

  it('does not consider disjoint windows overlapping', () => {
    expect(windowsOverlap({ label: 'a', fromMs: 0, toMs: 100 }, { label: 'b', fromMs: 200, toMs: 300 })).toBe(false);
  });
});

describe('excludeOverlapping', () => {
  const incident = { label: 'incident', fromMs: 1000, toMs: 2000 };

  it('keeps windows that do not overlap the incident', () => {
    const items = [{ window: { label: 'clean', fromMs: 5000, toMs: 6000 } }];
    const { kept, excludedLabels } = excludeOverlapping(incident, items);
    expect(kept).toEqual(items);
    expect(excludedLabels).toEqual([]);
  });

  it('excludes windows that overlap the incident and reports their labels', () => {
    const items = [
      { window: { label: 'overlapping', fromMs: 1500, toMs: 2500 } },
      { window: { label: 'clean', fromMs: 5000, toMs: 6000 } },
    ];
    const { kept, excludedLabels } = excludeOverlapping(incident, items);
    expect(kept.map((i) => i.window.label)).toEqual(['clean']);
    expect(excludedLabels).toEqual(['overlapping']);
  });
});
