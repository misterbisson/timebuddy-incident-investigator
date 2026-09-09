/**
 * Grafana's relative-time ("date math") expression grammar, resolved to an
 * absolute epoch-ms instant.
 *
 * A dashboard link's `from`/`to` params carry Grafana's own expression
 * language, not just `now-1h`: an anchor (`now`, or an absolute date followed
 * by `||`) plus any number of operators applied left to right — `-<N><unit>`
 * / `+<N><unit>` to shift, and `/<unit>` to *round* to a period boundary.
 * `now/w-28d` ("28 days ending at the end of last week") is one expression,
 * two operators: round to the week, then shift back four weeks.
 *
 * Three details make rounding meaningfully harder than shifting, and getting
 * any of them wrong yields a plausible-looking window that's off by hours or
 * days rather than an error (issue #216):
 *
 * 1. **The two bounds of a range round in opposite directions.** Grafana's
 *    `rangeUtil.convertRawToRange` calls `dateMath.parse(from, false)` and
 *    `dateMath.parse(to, true)`, and that flag picks `startOf(unit)` vs.
 *    `endOf(unit)`. So in a `from=now/w-28d&to=now/w-7d` pair the two `/w`s
 *    are *not* the same instant-of-week: `from` snaps to the week's start,
 *    `to` to its last millisecond, and only then does each day offset apply.
 *    Callers must pass `roundUp: true` for a `to` bound — see
 *    GrafanaTimeOptions.
 * 2. **A period boundary is a wall-clock boundary**, so it depends on the time
 *    zone the range is being read in. `now/d` in `America/Los_Angeles` is
 *    seven or eight hours away from `now/d` in UTC. The same is true of *day
 *    and larger* shifts, which Grafana (via moment) applies as calendar
 *    arithmetic that preserves wall-clock time across a DST transition, not as
 *    fixed millisecond durations.
 * 3. **`/w` additionally depends on the configured week-start**, which is a
 *    Grafana org/user preference (Saturday, Sunday, or Monday), not a
 *    universal constant.
 *
 * This module is pure: the caller resolves the zone/week-start context (see
 * grafana/preferences.ts and tools/renderDashboard.ts's resolveRenderWindow)
 * and passes it in. Anything it cannot classify throws rather than resolving
 * approximately — the whole point is that a mis-resolved window is invisible.
 */

export type WeekStart = 'saturday' | 'sunday' | 'monday';

/** Day index as `Date#getUTCDay` numbers them: 0 = Sunday. */
const WEEK_START_DAY: Record<WeekStart, number> = { sunday: 0, monday: 1, saturday: 6 };

/**
 * The documented fallbacks, used when neither the URL, the dashboard, nor the
 * connection's own Grafana preferences settle the question. Both are stated in
 * README.md and docs/BEHAVIOR.md, and every tool that resolves a relative
 * expression reports which of them it actually used (and where it came from),
 * because a wrong choice here is otherwise silent.
 *
 * UTC because there is no browser on this side to inherit a zone from —
 * Grafana's own `''`/`browser` default is a client-side notion. Sunday because
 * that is what Grafana itself effectively resolves an unset `week_start` to in
 * an `en` locale (its `setWeekStart` restores moment's locale default, which
 * for `en` is Sunday).
 */
export const DEFAULT_TIME_ZONE = 'UTC';
export const DEFAULT_WEEK_START: WeekStart = 'sunday';

export interface GrafanaTimeOptions {
  /**
   * Round `/<unit>` operators *up* (to the period's last millisecond) instead
   * of down. Pass true for a range's `to` bound and false/omitted for its
   * `from` bound — see detail 1 in this module's header.
   */
  roundUp?: boolean;
  /** IANA zone name (or `UTC`) the wall-clock boundaries are read in. Defaults to DEFAULT_TIME_ZONE. */
  timeZone?: string;
  /** Which day `/w` snaps to. Defaults to DEFAULT_WEEK_START. */
  weekStart?: WeekStart;
}

type Unit = 's' | 'm' | 'h' | 'd' | 'w' | 'M' | 'Q' | 'y';

const UNITS: ReadonlySet<string> = new Set<Unit>(['s', 'm', 'h', 'd', 'w', 'M', 'Q', 'y']);

interface TimeOp {
  op: '/' | '+' | '-';
  amount: number;
  unit: Unit;
}

/** What a caller has to resolve before an expression can be evaluated correctly. */
export interface TimeExprShape {
  /**
   * The expression's value depends on the reference time or on date math —
   * i.e. it isn't a bare epoch-ms/ISO instant. Used to decide whether a
   * resolved window is worth reporting back to the caller at all.
   */
  relative: boolean;
  /** Contains at least one `/<unit>` rounding operator. */
  rounds: boolean;
  /** Rounds to a week — the one unit whose boundary depends on the configured week-start. */
  roundsWeek: boolean;
  /**
   * Resolving it needs a time zone: any rounding, or any shift by a day or
   * larger (those are calendar arithmetic, so a DST transition inside the
   * shift moves the result). A pure `now-90m` is zone-independent, which is
   * what lets the common case skip the preferences lookup entirely.
   */
  zoneSensitive: boolean;
}

function invalidExpr(value: string): Error {
  return new Error(
    `Could not parse Grafana time param "${value}" — expected "now", Grafana relative-time date math ` +
      '("now-1h", "now/d", "now/w-7d", "<iso-date>||-1d"; units s/m/h/d/w/M/Q/y, "/" rounds to the period), ' +
      'an epoch-ms number, or an ISO 8601 date/time.',
  );
}

function parseAbsolute(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Splits an expression into its anchor instant and the operator string that
 * follows, mirroring Grafana's `dateMath.parse`: a leading `now` anchors on the
 * reference time, otherwise the text up to `||` is an absolute date and the
 * rest is date math (a bare absolute date is just the whole string).
 */
function splitAnchor(value: string, nowMs: number): { anchorMs: number; math: string } {
  if (value.startsWith('now')) return { anchorMs: nowMs, math: value.slice(3) };
  const sep = value.indexOf('||');
  const datePart = sep === -1 ? value : value.slice(0, sep);
  const anchorMs = parseAbsolute(datePart);
  if (anchorMs === undefined) throw invalidExpr(value);
  return { anchorMs, math: sep === -1 ? '' : value.slice(sep + 2) };
}

function parseOps(math: string, whole: string): TimeOp[] {
  const ops: TimeOp[] = [];
  let i = 0;
  while (i < math.length) {
    const op = math[i]!;
    if (op !== '/' && op !== '+' && op !== '-') throw invalidExpr(whole);
    i += 1;
    let digits = '';
    while (i < math.length && math[i]! >= '0' && math[i]! <= '9') {
      digits += math[i]!;
      i += 1;
    }
    const unit = math[i];
    if (unit === undefined || !UNITS.has(unit)) {
      // Grafana also accepts fiscal-period units ("fQ"/"fy"), whose boundaries
      // depend on a fiscalYearStartMonth this client never reads. Named
      // explicitly so the refusal points at the missing input rather than
      // reading as a typo.
      if (unit === 'f') {
        throw new Error(
          `Grafana time param "${whole}" uses a fiscal-period unit ("fQ"/"fy"), whose boundaries depend on the ` +
            "dashboard's fiscal-year start month — not supported. Pass fromMs/toMs explicitly for a fiscal window.",
        );
      }
      throw invalidExpr(whole);
    }
    i += 1;
    // Grafana's own parser allows a redundant count of exactly 1 on a rounding
    // operator ("now/1d") and rejects anything else ("now/2d") — rounding to
    // "two days" names no boundary.
    const amount = digits === '' ? 1 : Number(digits);
    if (op === '/' && amount !== 1) throw invalidExpr(whole);
    ops.push({ op, amount, unit: unit as Unit });
  }
  return ops;
}

/**
 * Reports what an expression needs resolved without resolving it, so a caller
 * can skip the per-connection preferences lookup for the overwhelmingly common
 * zone-independent case (`now`, `now-1h`, an absolute timestamp). Throws on an
 * expression `parseGrafanaTimeExpr` would also reject, so calling this first
 * fails fast rather than after an HTTP round-trip.
 */
export function describeGrafanaTimeExpr(value: string): TimeExprShape {
  const trimmed = value.trim();
  const relative = trimmed.startsWith('now') || trimmed.includes('||');
  if (!relative) {
    if (parseAbsolute(trimmed) === undefined) throw invalidExpr(value);
    return { relative: false, rounds: false, roundsWeek: false, zoneSensitive: false };
  }
  const { math } = splitAnchor(trimmed, 0);
  const ops = parseOps(math, value);
  const rounds = ops.some((o) => o.op === '/');
  return {
    relative: true,
    rounds,
    roundsWeek: ops.some((o) => o.op === '/' && o.unit === 'w'),
    zoneSensitive: rounds || ops.some((o) => o.unit === 'd' || o.unit === 'w' || o.unit === 'M' || o.unit === 'Q' || o.unit === 'y'),
  };
}

/**
 * Interprets one Grafana time expression — a dashboard link's `from`/`to`, or
 * a dashboard's own saved default range — against a reference time. See this
 * module's header for the grammar and for why `roundUp`/`timeZone`/`weekStart`
 * are not optional details.
 */
export function parseGrafanaTimeExpr(value: string, nowMs: number, opts: GrafanaTimeOptions = {}): number {
  const zone = new Zone(opts.timeZone ?? DEFAULT_TIME_ZONE);
  const weekStartDay = WEEK_START_DAY[opts.weekStart ?? DEFAULT_WEEK_START];
  const trimmed = value.trim();
  const { anchorMs, math } = splitAnchor(trimmed, nowMs);
  let time = anchorMs;
  for (const { op, amount, unit } of parseOps(math, value)) {
    if (op === '/') {
      time = opts.roundUp ? zone.endOf(time, unit, weekStartDay) : zone.startOf(time, unit, weekStartDay);
    } else {
      time = zone.shift(time, op === '-' ? -amount : amount, unit);
    }
  }
  return time;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * Zone-aware calendar arithmetic on epoch-ms, built on `Intl.DateTimeFormat`
 * rather than a date library (this package has no runtime date dependency and
 * the surface needed here is small).
 *
 * Reading a wall clock out of an instant is direct; putting one back is not,
 * because the offset to apply is itself a function of the instant you're
 * trying to compute. `toInstant` does the standard two-pass fixpoint: guess
 * with the offset in effect at the naive UTC reading, then re-read the offset
 * at that guess and correct — which lands on the right side of a DST
 * transition instead of an hour off.
 */
class Zone {
  constructor(private readonly timeZone: string) {
    if (!FORMATTERS.has(timeZone)) {
      let formatter: Intl.DateTimeFormat;
      try {
        formatter = new Intl.DateTimeFormat('en-US', {
          timeZone,
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
      } catch {
        throw new Error(
          `Unknown time zone "${timeZone}" — expected an IANA zone name (e.g. "America/Los_Angeles") or "UTC".`,
        );
      }
      FORMATTERS.set(timeZone, formatter);
    }
  }

  private wallClock(ms: number): WallClock {
    const parts = FORMATTERS.get(this.timeZone)!.formatToParts(new Date(ms));
    const field = (type: string): number => Number(parts.find((p) => p.type === type)!.value);
    const hour = field('hour');
    return {
      year: field('year'),
      month: field('month'),
      day: field('day'),
      // Some ICU versions render midnight as "24" even under hourCycle h23.
      hour: hour === 24 ? 0 : hour,
      minute: field('minute'),
      second: field('second'),
      // Sub-second is offset-invariant (every zone offset is a whole number of
      // minutes), so it's read off the instant rather than formatted — which
      // also sidesteps patchy fractionalSecondDigits support.
      ms: ((ms % 1000) + 1000) % 1000,
    };
  }

  private offsetAt(ms: number): number {
    const w = this.wallClock(ms);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.ms) - ms;
  }

  /**
   * Field values may be out of range (day 0, day -3, month 13); they're
   * normalized the way `Date.UTC` normalizes them, which is also how moment
   * treats an overflowing set — so callers can subtract days from a
   * day-of-month without special-casing month boundaries.
   */
  private toInstant(w: WallClock): number {
    const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.ms);
    const guess = naive - this.offsetAt(naive);
    return naive - this.offsetAt(guess);
  }

  startOf(ms: number, unit: Unit, weekStartDay: number): number {
    const w = this.wallClock(ms);
    const midnight = { ...w, hour: 0, minute: 0, second: 0, ms: 0 };
    switch (unit) {
      case 's':
        return this.toInstant({ ...w, ms: 0 });
      case 'm':
        return this.toInstant({ ...w, second: 0, ms: 0 });
      case 'h':
        return this.toInstant({ ...w, minute: 0, second: 0, ms: 0 });
      case 'd':
        return this.toInstant(midnight);
      case 'w': {
        const dayOfWeek = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
        return this.toInstant({ ...midnight, day: w.day - ((dayOfWeek - weekStartDay + 7) % 7) });
      }
      case 'M':
        return this.toInstant({ ...midnight, day: 1 });
      case 'Q':
        return this.toInstant({ ...midnight, month: w.month - ((w.month - 1) % 3), day: 1 });
      case 'y':
        return this.toInstant({ ...midnight, month: 1, day: 1 });
    }
  }

  /**
   * The period's last millisecond, computed as "start of the next period minus
   * 1ms" — which is exactly what moment's `endOf` does, and therefore stays
   * right on a day that a DST transition made 23 or 25 hours long.
   */
  endOf(ms: number, unit: Unit, weekStartDay: number): number {
    return this.shift(this.startOf(ms, unit, weekStartDay), 1, unit) - 1;
  }

  shift(ms: number, amount: number, unit: Unit): number {
    if (amount === 0) return ms;
    switch (unit) {
      // Fixed durations, matching moment's sub-day units: an hour is an hour
      // even across a transition.
      case 's':
        return ms + amount * 1000;
      case 'm':
        return ms + amount * 60_000;
      case 'h':
        return ms + amount * 3_600_000;
      // Calendar units: preserve the wall clock, so "now-1d" is the same
      // clock time yesterday even when yesterday was 23 hours long.
      case 'd':
      case 'w': {
        const w = this.wallClock(ms);
        return this.toInstant({ ...w, day: w.day + amount * (unit === 'w' ? 7 : 1) });
      }
      case 'M':
      case 'Q':
      case 'y': {
        const w = this.wallClock(ms);
        const months = amount * (unit === 'M' ? 1 : unit === 'Q' ? 3 : 12);
        const index = w.year * 12 + (w.month - 1) + months;
        const year = Math.floor(index / 12);
        const month = (((index % 12) + 12) % 12) + 1;
        // Clamp rather than overflow, as moment (and therefore Grafana) does:
        // 2026-03-31 minus one month is 2026-02-28, not 2026-03-03. Date.UTC's
        // own normalization would give the latter.
        const day = Math.min(w.day, new Date(Date.UTC(year, month, 0)).getUTCDate());
        return this.toInstant({ ...w, year, month, day });
      }
    }
  }
}

/** Normalizes a Grafana `weekStart` preference value; undefined when unset or client-derived ("browser"). */
export function normalizeWeekStart(value: string | undefined): WeekStart | undefined {
  const lower = value?.trim().toLowerCase();
  return lower === 'saturday' || lower === 'sunday' || lower === 'monday' ? lower : undefined;
}

/**
 * Normalizes a Grafana timezone value (a dashboard's `timezone`, a URL's
 * `timezone` param, or a preferences field). Grafana's `''`, `browser` and
 * `default` all mean "ask the client", which this side can't do — they come
 * back undefined so the caller falls through to the next tier and ultimately
 * to DEFAULT_TIME_ZONE. `utc` is Grafana's own spelling of UTC.
 */
export function normalizeTimeZone(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === 'browser' || lower === 'default') return undefined;
  if (lower === 'utc') return 'UTC';
  return trimmed;
}

/** Throws a message naming where an unusable zone came from, rather than silently resolving the window somewhere else. */
export function assertKnownTimeZone(timeZone: string, source: string): void {
  try {
    new Zone(timeZone);
  } catch {
    throw new Error(
      `Time zone "${timeZone}" (from ${source}) is not a zone this runtime knows — expected an IANA zone name ` +
        '(e.g. "America/Los_Angeles") or "UTC". Pass fromMs/toMs explicitly to resolve the window yourself.',
    );
  }
}
