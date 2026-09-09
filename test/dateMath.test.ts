import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIME_ZONE,
  DEFAULT_WEEK_START,
  describeGrafanaTimeExpr,
  normalizeTimeZone,
  normalizeWeekStart,
  parseGrafanaTimeExpr,
} from '../src/query/dateMath.js';

const at = (iso: string) => Date.parse(iso);

describe('parseGrafanaTimeExpr', () => {
  // A Tuesday, so every week-start (Sat/Sun/Mon) snaps to a different day.
  const nowMs = at('2026-07-07T12:00:00Z');

  it('resolves "now" to the reference time', () => {
    expect(parseGrafanaTimeExpr('now', nowMs)).toBe(nowMs);
  });

  it('resolves "now-<N><unit>" for seconds/minutes/hours/days/weeks', () => {
    expect(parseGrafanaTimeExpr('now-30s', nowMs)).toBe(nowMs - 30_000);
    expect(parseGrafanaTimeExpr('now-15m', nowMs)).toBe(nowMs - 15 * 60_000);
    expect(parseGrafanaTimeExpr('now-1h', nowMs)).toBe(nowMs - 3_600_000);
    expect(parseGrafanaTimeExpr('now-30d', nowMs)).toBe(nowMs - 30 * 86_400_000);
    expect(parseGrafanaTimeExpr('now-2w', nowMs)).toBe(nowMs - 14 * 86_400_000);
  });

  it('resolves months and years using calendar arithmetic, not a fixed-day approximation', () => {
    expect(parseGrafanaTimeExpr('now-1M', nowMs)).toBe(at('2026-06-07T12:00:00Z'));
    expect(parseGrafanaTimeExpr('now-1y', nowMs)).toBe(at('2025-07-07T12:00:00Z'));
    expect(parseGrafanaTimeExpr('now-1Q', nowMs)).toBe(at('2026-04-07T12:00:00Z'));
  });

  it('clamps a month shift to the last day of the target month rather than overflowing into the next one', () => {
    // moment (and so Grafana) gives Feb 28 here; naive month arithmetic gives
    // Mar 3, which reads as a plausible date and is a month plus three days off.
    expect(parseGrafanaTimeExpr('now-1M', at('2026-03-31T12:00:00Z'))).toBe(at('2026-02-28T12:00:00Z'));
  });

  it('resolves "+" shifts as well as "-"', () => {
    expect(parseGrafanaTimeExpr('now+1d', nowMs)).toBe(at('2026-07-08T12:00:00Z'));
    expect(parseGrafanaTimeExpr('now+90m', nowMs)).toBe(nowMs + 90 * 60_000);
  });

  it('parses an absolute epoch-ms numeric string', () => {
    expect(parseGrafanaTimeExpr('1780704000000', nowMs)).toBe(1780704000000);
  });

  it('parses an ISO 8601 date/time string', () => {
    expect(parseGrafanaTimeExpr('2026-06-08T00:00:00Z', nowMs)).toBe(at('2026-06-08T00:00:00Z'));
  });

  it('applies date math to an absolute anchor given in Grafana\'s "<date>||<math>" form', () => {
    expect(parseGrafanaTimeExpr('2026-06-08T00:00:00Z||-1d', nowMs)).toBe(at('2026-06-07T00:00:00Z'));
  });

  describe('period rounding', () => {
    it('rounds down for a "from" bound and up for a "to" bound', () => {
      expect(parseGrafanaTimeExpr('now/d', nowMs)).toBe(at('2026-07-07T00:00:00.000Z'));
      expect(parseGrafanaTimeExpr('now/d', nowMs, { roundUp: true })).toBe(at('2026-07-07T23:59:59.999Z'));
    });

    it('rounds to month, quarter and year boundaries', () => {
      expect(parseGrafanaTimeExpr('now/M', nowMs)).toBe(at('2026-07-01T00:00:00.000Z'));
      expect(parseGrafanaTimeExpr('now/M', nowMs, { roundUp: true })).toBe(at('2026-07-31T23:59:59.999Z'));
      expect(parseGrafanaTimeExpr('now/Q', nowMs)).toBe(at('2026-07-01T00:00:00.000Z'));
      expect(parseGrafanaTimeExpr('now/Q', nowMs, { roundUp: true })).toBe(at('2026-09-30T23:59:59.999Z'));
      expect(parseGrafanaTimeExpr('now/y', nowMs)).toBe(at('2026-01-01T00:00:00.000Z'));
      expect(parseGrafanaTimeExpr('now/y', nowMs, { roundUp: true })).toBe(at('2026-12-31T23:59:59.999Z'));
    });

    it('rounds sub-day units too', () => {
      expect(parseGrafanaTimeExpr('now/h', at('2026-07-07T12:34:56.789Z'))).toBe(at('2026-07-07T12:00:00.000Z'));
      expect(parseGrafanaTimeExpr('now/m', at('2026-07-07T12:34:56.789Z'))).toBe(at('2026-07-07T12:34:00.000Z'));
      expect(parseGrafanaTimeExpr('now/s', at('2026-07-07T12:34:56.789Z'))).toBe(at('2026-07-07T12:34:56.000Z'));
    });

    it('applies operators left to right, so "now-1d/d" rounds the shifted instant', () => {
      expect(parseGrafanaTimeExpr('now-1d/d', nowMs)).toBe(at('2026-07-06T00:00:00.000Z'));
      expect(parseGrafanaTimeExpr('now-1d/d', nowMs, { roundUp: true })).toBe(at('2026-07-06T23:59:59.999Z'));
    });

    it('snaps "/w" to the configured week-start', () => {
      expect(parseGrafanaTimeExpr('now/w', nowMs, { weekStart: 'sunday' })).toBe(at('2026-07-05T00:00:00.000Z'));
      expect(parseGrafanaTimeExpr('now/w', nowMs, { weekStart: 'monday' })).toBe(at('2026-07-06T00:00:00.000Z'));
      expect(parseGrafanaTimeExpr('now/w', nowMs, { weekStart: 'saturday' })).toBe(at('2026-07-04T00:00:00.000Z'));
      expect(parseGrafanaTimeExpr('now/w', nowMs, { weekStart: 'monday', roundUp: true })).toBe(at('2026-07-12T23:59:59.999Z'));
    });

    it('accepts a redundant count of 1 on a rounding operator and rejects any other count', () => {
      expect(parseGrafanaTimeExpr('now/1d', nowMs)).toBe(at('2026-07-07T00:00:00.000Z'));
      expect(() => parseGrafanaTimeExpr('now/2d', nowMs)).toThrow(/Could not parse Grafana time param "now\/2d"/);
    });
  });

  describe("issue #216's real link: from=now/w-28d&to=now/w-7d", () => {
    // The asymmetric snap is the whole point: from takes the week's start and
    // to takes its last millisecond, so the pair is exactly 28 days. Snapping
    // both to the same edge would silently produce ~21 or ~35.
    const window = (weekStart: 'sunday' | 'monday') => ({
      fromMs: parseGrafanaTimeExpr('now/w-28d', nowMs, { weekStart }),
      toMs: parseGrafanaTimeExpr('now/w-7d', nowMs, { weekStart, roundUp: true }),
    });

    it('spans exactly 28 days, ending at the end of last week (Monday week-start)', () => {
      const { fromMs, toMs } = window('monday');
      expect(fromMs).toBe(at('2026-06-08T00:00:00.000Z'));
      expect(toMs).toBe(at('2026-07-05T23:59:59.999Z'));
      expect(toMs - fromMs).toBe(28 * 86_400_000 - 1);
    });

    it('shifts by a day when the week starts on Sunday instead', () => {
      const { fromMs, toMs } = window('sunday');
      expect(fromMs).toBe(at('2026-06-07T00:00:00.000Z'));
      expect(toMs).toBe(at('2026-07-04T23:59:59.999Z'));
      expect(toMs - fromMs).toBe(28 * 86_400_000 - 1);
    });
  });

  describe('time zones', () => {
    it('rounds to the wall-clock boundary of the given zone, not UTC', () => {
      expect(parseGrafanaTimeExpr('now/d', nowMs, { timeZone: 'America/Los_Angeles' })).toBe(at('2026-07-07T07:00:00.000Z'));
      expect(parseGrafanaTimeExpr('now/d', nowMs, { timeZone: 'America/Los_Angeles', roundUp: true })).toBe(
        at('2026-07-08T06:59:59.999Z'),
      );
    });

    it('rounds a 23-hour DST day to its real boundaries', () => {
      // 2026-03-08 is spring-forward in America/New_York: the local day runs
      // 00:00 EST to 24:00 EDT, i.e. 23 hours.
      const noonOnTransitionDay = at('2026-03-08T16:00:00Z');
      const startOfDay = parseGrafanaTimeExpr('now/d', noonOnTransitionDay, { timeZone: 'America/New_York' });
      const endOfDay = parseGrafanaTimeExpr('now/d', noonOnTransitionDay, { timeZone: 'America/New_York', roundUp: true });
      expect(startOfDay).toBe(at('2026-03-08T05:00:00.000Z'));
      expect(endOfDay).toBe(at('2026-03-09T03:59:59.999Z'));
      expect(endOfDay - startOfDay).toBe(23 * 3_600_000 - 1);
    });

    it('shifts by a calendar day across a DST transition, preserving wall-clock time', () => {
      // Noon Sunday EDT minus one day is noon Saturday EST — 25 hours, which
      // a fixed 86_400_000 subtraction would get wrong by an hour.
      expect(parseGrafanaTimeExpr('now-1d', at('2026-03-08T16:00:00Z'), { timeZone: 'America/New_York' })).toBe(
        at('2026-03-07T17:00:00Z'),
      );
    });

    it('keeps sub-day shifts as exact durations, the way moment does', () => {
      expect(parseGrafanaTimeExpr('now-24h', at('2026-03-08T16:00:00Z'), { timeZone: 'America/New_York' })).toBe(
        at('2026-03-07T16:00:00Z'),
      );
    });

    it('defaults to UTC and Sunday when no context is given', () => {
      expect(DEFAULT_TIME_ZONE).toBe('UTC');
      expect(DEFAULT_WEEK_START).toBe('sunday');
      expect(parseGrafanaTimeExpr('now/d', nowMs)).toBe(parseGrafanaTimeExpr('now/d', nowMs, { timeZone: 'UTC' }));
      expect(parseGrafanaTimeExpr('now/w', nowMs)).toBe(parseGrafanaTimeExpr('now/w', nowMs, { weekStart: 'sunday' }));
    });

    it('throws for a zone this runtime does not know rather than silently using UTC', () => {
      expect(() => parseGrafanaTimeExpr('now/d', nowMs, { timeZone: 'Mars/Olympus_Mons' })).toThrow(/Unknown time zone/);
    });
  });

  describe('refusals', () => {
    it('rejects an unknown unit', () => {
      expect(() => parseGrafanaTimeExpr('now-1x', nowMs)).toThrow(/Could not parse Grafana time param "now-1x"/);
    });

    it('rejects a truncated expression', () => {
      expect(() => parseGrafanaTimeExpr('now-', nowMs)).toThrow(/Could not parse Grafana time param/);
      expect(() => parseGrafanaTimeExpr('now/', nowMs)).toThrow(/Could not parse Grafana time param/);
      expect(() => parseGrafanaTimeExpr('now-5', nowMs)).toThrow(/Could not parse Grafana time param/);
    });

    it('rejects trailing garbage after a valid operator instead of ignoring it', () => {
      expect(() => parseGrafanaTimeExpr('now-1h!', nowMs)).toThrow(/Could not parse Grafana time param/);
    });

    it('rejects a non-time string', () => {
      expect(() => parseGrafanaTimeExpr('yesterday', nowMs)).toThrow(/Could not parse Grafana time param "yesterday"/);
    });

    it('names fiscal-period units specifically, since their boundaries need an input this client never reads', () => {
      expect(() => parseGrafanaTimeExpr('now/fQ', nowMs)).toThrow(/fiscal-period unit/);
      expect(() => parseGrafanaTimeExpr('now-1fy', nowMs)).toThrow(/fiscal-period unit/);
    });
  });
});

describe('describeGrafanaTimeExpr', () => {
  it('reports an absolute instant as needing nothing resolved', () => {
    expect(describeGrafanaTimeExpr('1780704000000')).toEqual({
      relative: false,
      rounds: false,
      roundsWeek: false,
      zoneSensitive: false,
    });
    expect(describeGrafanaTimeExpr('2026-06-08T00:00:00Z').relative).toBe(false);
  });

  it('reports a sub-day relative expression as zone-independent, so the preferences lookup can be skipped', () => {
    expect(describeGrafanaTimeExpr('now')).toEqual({
      relative: true,
      rounds: false,
      roundsWeek: false,
      zoneSensitive: false,
    });
    expect(describeGrafanaTimeExpr('now-90m').zoneSensitive).toBe(false);
    expect(describeGrafanaTimeExpr('now-6h').zoneSensitive).toBe(false);
  });

  it('reports a day-or-larger shift as zone-sensitive, since it is calendar arithmetic', () => {
    expect(describeGrafanaTimeExpr('now-30d').zoneSensitive).toBe(true);
    expect(describeGrafanaTimeExpr('now-1M').zoneSensitive).toBe(true);
  });

  it('distinguishes week rounding, the only unit that needs a week-start', () => {
    expect(describeGrafanaTimeExpr('now/d')).toEqual({
      relative: true,
      rounds: true,
      roundsWeek: false,
      zoneSensitive: true,
    });
    expect(describeGrafanaTimeExpr('now/w-28d')).toEqual({
      relative: true,
      rounds: true,
      roundsWeek: true,
      zoneSensitive: true,
    });
  });

  it('throws on the same expressions parseGrafanaTimeExpr rejects, so a caller fails before paying for a lookup', () => {
    expect(() => describeGrafanaTimeExpr('now/2d')).toThrow(/Could not parse Grafana time param/);
    expect(() => describeGrafanaTimeExpr('whenever')).toThrow(/Could not parse Grafana time param/);
  });
});

describe('normalizeTimeZone', () => {
  it('treats Grafana\'s client-derived values as unset, so the caller falls through to the next tier', () => {
    for (const value of [undefined, '', '  ', 'browser', 'Browser', 'default']) {
      expect(normalizeTimeZone(value)).toBeUndefined();
    }
  });

  it('maps Grafana\'s "utc" spelling and passes IANA names through', () => {
    expect(normalizeTimeZone('utc')).toBe('UTC');
    expect(normalizeTimeZone('UTC')).toBe('UTC');
    expect(normalizeTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles');
  });
});

describe('normalizeWeekStart', () => {
  it('accepts the three values Grafana offers, case-insensitively', () => {
    expect(normalizeWeekStart('monday')).toBe('monday');
    expect(normalizeWeekStart('Sunday')).toBe('sunday');
    expect(normalizeWeekStart('SATURDAY')).toBe('saturday');
  });

  it('treats unset and client-derived values as unresolved', () => {
    for (const value of [undefined, '', 'browser', 'wednesday']) {
      expect(normalizeWeekStart(value)).toBeUndefined();
    }
  });
});
