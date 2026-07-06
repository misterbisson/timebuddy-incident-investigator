import { describe, expect, it } from 'vitest';
import { computeWindows } from '../src/query/windows.js';

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
});
