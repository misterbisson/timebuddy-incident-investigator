import type { PanelTarget } from '../grafana/types.js';
import type { ResolvedTarget } from './panelQueries.js';
import { applyPromqlFilter, applyPromqlGroupBy, RewriteFailure } from './promqlBreakout.js';

export interface TagBreakout {
  /** Tag key to break out on, e.g. "host" / "instance" / "target_host". */
  key: string;
  /**
   * When set, filter the panel's query to this exact tag value (one series for
   * that host). When omitted, GROUP BY the key instead, splitting the
   * aggregated series into one series per value — so a single hot host that was
   * hidden inside a cross-host aggregate becomes visible.
   */
  value?: string;
}

/**
 * Thrown when a tag breakout is requested against a target we can't safely
 * rewrite. It's a hard error on purpose — silently returning the panel's
 * original aggregated query would look like a breakout that found nothing
 * per-host, which is exactly the misleading result #126 exists to avoid.
 */
export class TagBreakoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TagBreakoutError';
  }
}

/**
 * Builder-mode InfluxQL targets support the breakout injection-free: we
 * never assemble InfluxQL text, we add structured `tags`/`groupBy` fields to
 * the target and let Grafana's own InfluxDB backend build and escape the
 * query (the same path execute_query_window already trusts to run
 * builder-mode targets). Raw-mode InfluxQL would mean string-rewriting live
 * query text, so it's refused below. PromQL targets go through
 * promqlBreakout.ts instead, which does rewrite query text — see its own
 * doc comment for how it keeps that safe. Loki (LogQL) breakout is a further
 * generalization, scoped separately if/when needed (#131's notes).
 */
function assertBreakoutSupported(t: PanelTarget): void {
  // Any truthy rawQuery means raw mode — a genuine builder target always has
  // rawQuery false/absent. Guarding on `=== true` would let a non-standard
  // dashboard that stored rawQuery as a truthy non-boolean (e.g. "true") with
  // a populated `measurement` fall through and get mutated while Grafana ran
  // the original raw query — the silent un-broken-out result we refuse to emit.
  if (t.rawQuery) {
    throw new TagBreakoutError(
      `refId ${t.refId}: this InfluxQL target runs a raw query string (rawQuery: true), which tagBreakout won't ` +
        'rewrite — editing live InfluxQL text can\'t be done safely. Only builder-mode InfluxQL targets ' +
        '(a "measurement" plus structured tags/groupBy fields) are supported. If you need a per-host cut of a ' +
        'raw-query panel, add the GROUP BY / WHERE clause to the query yourself.',
    );
  }
  if (typeof t.measurement !== 'string' || t.measurement.length === 0) {
    throw new TagBreakoutError(
      `refId ${t.refId}: tagBreakout couldn't identify a supported query type on this target (no builder-mode ` +
        'InfluxQL "measurement", no PromQL "expr"). Only builder-mode InfluxQL and PromQL targets are supported.',
    );
  }
}

type TagFilter = NonNullable<PanelTarget['tags']>[number];

/**
 * Appends a `key = value` WHERE constraint. Grafana's InfluxDB backend quotes
 * and escapes the value itself when it builds the query, so the raw host string
 * goes in as-is (no injection surface). A 2nd+ tag needs an explicit AND
 * condition or the backend drops it from the WHERE. Idempotent: re-applying the
 * same filter is a no-op rather than a duplicated clause.
 */
function addTagFilter(existing: PanelTarget['tags'], key: string, value: string): TagFilter[] {
  const tags: TagFilter[] = existing ? [...existing] : [];
  if (tags.some((t) => t.key === key && t.operator === '=' && t.value === value)) return tags;
  const entry: TagFilter = { key, operator: '=', value };
  if (tags.length > 0) entry.condition = 'AND';
  return [...tags, entry];
}

interface GroupByPart {
  type?: string;
  params?: unknown[];
}

/**
 * Grafana's InfluxQL query model stores groupBy as a flat array of parts
 * ({type:'time'|'tag'|'fill', params}); the one in-repo fixture happens to nest
 * each part in its own array, and there's no live-captured dashboard JSON here
 * to settle which a given estate uses — so both shapes are read and preserved.
 */
function partOf(entry: unknown): GroupByPart | undefined {
  const obj = Array.isArray(entry) ? entry[0] : entry;
  return obj && typeof obj === 'object' ? (obj as GroupByPart) : undefined;
}

function isPartType(entry: unknown, type: string): boolean {
  return partOf(entry)?.type === type;
}

function isTagPart(entry: unknown, key: string): boolean {
  const part = partOf(entry);
  return part?.type === 'tag' && Array.isArray(part.params) && part.params[0] === key;
}

/**
 * Inserts a `GROUP BY "key"` tag part, matching whatever element shape the
 * existing groupBy already uses (flat vs. nested — see partOf). InfluxQL
 * requires `fill(...)` to be the last group-by clause, so the tag part goes
 * *before* any existing fill part rather than after it. Idempotent: grouping by
 * a key already grouped on is a no-op.
 */
function addGroupByTag(existing: PanelTarget['groupBy'], key: string): unknown[] {
  const groupBy: unknown[] = Array.isArray(existing) ? [...existing] : [];
  if (groupBy.some((p) => isTagPart(p, key))) return groupBy;
  const nested = groupBy.length > 0 && Array.isArray(groupBy[0]);
  const tagPart: GroupByPart = { type: 'tag', params: [key] };
  const entry: unknown = nested ? [tagPart] : tagPart;
  const fillIdx = groupBy.findIndex((p) => isPartType(p, 'fill'));
  if (fillIdx === -1) return [...groupBy, entry];
  groupBy.splice(fillIdx, 0, entry);
  return groupBy;
}

/**
 * Returns a copy of the target with the breakout applied to its InfluxQL
 * builder fields, or throws TagBreakoutError if the target can't be broken out
 * safely (see assertBreakoutSupported). Only the `tags`/`groupBy` builder
 * fields are touched; everything else on the target is preserved so the rest of
 * the execute path (datasource resolution, maxDataPoints, etc.) is unchanged.
 */
export function applyTagBreakout(target: ResolvedTarget, breakout: TagBreakout): ResolvedTarget {
  if (typeof target.raw.expr === 'string') return applyPromqlTagBreakout(target, breakout);
  assertBreakoutSupported(target.raw);
  const raw: PanelTarget = { ...target.raw };
  if (breakout.value !== undefined) {
    raw.tags = addTagFilter(raw.tags, breakout.key, breakout.value);
  } else {
    raw.groupBy = addGroupByTag(raw.groupBy, breakout.key);
  }
  return { ...target, raw };
}

/**
 * promqlBreakout.ts's rewrite functions throw a plain RewriteFailure with no
 * knowledge of which refId they're operating on (they only ever see the
 * `expr` string) — wrapped here into the same TagBreakoutError/refId-tagged
 * contract every other unsupported-target error already uses, so a caller
 * can't tell PromQL and InfluxQL refusals apart by exception shape.
 */
function applyPromqlTagBreakout(target: ResolvedTarget, breakout: TagBreakout): ResolvedTarget {
  const t = target.raw;
  try {
    const expr = breakout.value !== undefined
      ? applyPromqlFilter(t.expr!, breakout.key, breakout.value)
      : applyPromqlGroupBy(t.expr!, breakout.key);
    return { ...target, raw: { ...t, expr } };
  } catch (err) {
    if (!(err instanceof RewriteFailure)) throw err;
    throw new TagBreakoutError(`refId ${t.refId}: tagBreakout couldn't safely rewrite this PromQL query — ${err.message}`);
  }
}
