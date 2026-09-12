import { describe, expect, it } from 'vitest';
import { parseGrafanaTimeExpr, type WeekStart } from '../src/query/dateMath.js';

/**
 * Property tests for period rounding across awkward zones, checked against an
 * independent specification rather than against hand-computed constants:
 *
 *   startOf(period) is the FIRST instant whose local period equals the target,
 *   endOf(period)   is the LAST.
 *
 * The expected values are found by bisecting raw `Intl.DateTimeFormat` output,
 * so they share no logic with `dateMath.ts` — including none of its assumptions
 * about how a DST gap or an ambiguous hour resolves. That's the point: the
 * failure this guards against (issue #216 review) was a two-pass offset
 * fixpoint that looked right for a 02:00 transition and silently named the
 * wrong calendar day in zones that transition at midnight.
 */

function localKey(ms: number, timeZone: string, unit: 'd' | 'M' | 'y'): string {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
  return unit === 'd' ? ymd : unit === 'M' ? ymd.slice(0, 7) : ymd.slice(0, 4);
}

/** Bisect for the boundary; `spanDays` must put the bound outside the period so the predicate is monotonic. */
function firstInstantOf(key: (ms: number) => string, target: string, probe: number, spanDays: number): number {
  let [lo, hi] = [probe - spanDays * 86_400_000, probe];
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (key(mid) === target) hi = mid;
    else lo = mid;
  }
  return hi;
}

function lastInstantOf(key: (ms: number) => string, target: string, probe: number, spanDays: number): number {
  let [lo, hi] = [probe, probe + spanDays * 86_400_000];
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (key(mid) === target) lo = mid;
    else hi = mid;
  }
  return lo;
}

const ZONES: Array<{ timeZone: string; probe: string; note: string }> = [
  { timeZone: 'America/Havana', probe: '2026-03-08T18:00:00Z', note: 'spring-forward gap at midnight' },
  { timeZone: 'America/Havana', probe: '2026-11-01T18:00:00Z', note: 'midnight runs twice' },
  { timeZone: 'America/Santiago', probe: '2026-09-06T18:00:00Z', note: 'spring-forward gap at midnight' },
  { timeZone: 'America/Santiago', probe: '2026-04-05T18:00:00Z', note: 'midnight runs twice' },
  { timeZone: 'America/New_York', probe: '2026-03-08T16:00:00Z', note: '02:00 spring-forward' },
  { timeZone: 'America/New_York', probe: '2026-11-01T16:00:00Z', note: '02:00 fall-back' },
  { timeZone: 'Europe/Berlin', probe: '2026-03-29T12:00:00Z', note: '02:00 spring-forward' },
  { timeZone: 'Europe/Berlin', probe: '2026-10-25T12:00:00Z', note: '03:00 fall-back' },
  { timeZone: 'Australia/Lord_Howe', probe: '2026-10-04T02:00:00Z', note: '30-minute DST shift' },
  { timeZone: 'Pacific/Chatham', probe: '2026-09-27T02:00:00Z', note: '+12:45, transition at 02:45' },
  { timeZone: 'Asia/Kolkata', probe: '2026-07-07T12:00:00Z', note: 'half-hour offset, no DST' },
  { timeZone: 'Asia/Kathmandu', probe: '2026-07-07T12:00:00Z', note: '+05:45 offset' },
  { timeZone: 'UTC', probe: '2026-07-07T12:00:00Z', note: 'baseline' },
];

const UNIT_SPAN: Record<'d' | 'M' | 'y', number> = { d: 3, M: 40, y: 400 };

describe('period rounding across DST and sub-hour-offset zones', () => {
  for (const { timeZone, probe, note } of ZONES) {
    for (const unit of ['d', 'M', 'y'] as const) {
      it(`${timeZone} /${unit} on ${probe.slice(0, 10)} (${note})`, () => {
        const now = Date.parse(probe);
        const key = (ms: number) => localKey(ms, timeZone, unit);
        const target = key(now);
        const span = UNIT_SPAN[unit];

        const start = parseGrafanaTimeExpr(`now/${unit}`, now, { timeZone });
        const end = parseGrafanaTimeExpr(`now/${unit}`, now, { timeZone, roundUp: true });

        expect(new Date(start).toISOString()).toBe(new Date(firstInstantOf(key, target, now, span)).toISOString());
        expect(new Date(end).toISOString()).toBe(new Date(lastInstantOf(key, target, now, span)).toISOString());
        // Contiguous and exhaustive: nothing outside [start, end] is in the period.
        expect(key(start - 1)).not.toBe(target);
        expect(key(end + 1)).not.toBe(target);
      });
    }
  }
});

describe('week rounding across the same zones', () => {
  const WEEK_START_DAY: Record<WeekStart, number> = { sunday: 0, monday: 1, saturday: 6 };

  for (const { timeZone, probe, note } of ZONES) {
    for (const weekStart of ['sunday', 'monday', 'saturday'] as const) {
      it(`${timeZone} /w starting ${weekStart} on ${probe.slice(0, 10)} (${note})`, () => {
        const now = Date.parse(probe);
        const day = (ms: number) => localKey(ms, timeZone, 'd');
        const start = parseGrafanaTimeExpr('now/w', now, { timeZone, weekStart });
        const end = parseGrafanaTimeExpr('now/w', now, { timeZone, weekStart, roundUp: true });

        // Lands on the configured day, at the first instant of that local day.
        expect(new Date(`${day(start)}T00:00:00Z`).getUTCDay()).toBe(WEEK_START_DAY[weekStart]);
        expect(day(start - 1)).not.toBe(day(start));
        // Spans exactly seven local days, ending on the last instant of the seventh.
        const days = new Set<string>([day(end)]);
        for (let t = start; t <= end; t += 3_600_000) days.add(day(t));
        expect(days.size).toBe(7);
        expect(day(end + 1)).not.toBe(day(end));
      });
    }
  }
});
