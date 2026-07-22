import type { PanelTarget } from '../grafana/types.js';
import type { ResolvedTarget } from './panelQueries.js';

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
 * v1 supports builder-mode InfluxQL only. That isn't just a scope cut — it's
 * what keeps the breakout injection-free: we never assemble InfluxQL text, we
 * add structured `tags`/`groupBy` fields to the target and let Grafana's own
 * InfluxDB backend build and escape the query (the same path
 * execute_query_window already trusts to run builder-mode targets). Raw-mode
 * InfluxQL would mean string-rewriting live query text; PromQL/Loki is #127.
 */
function assertBreakoutSupported(t: PanelTarget): void {
  if (typeof t.expr === 'string') {
    throw new TagBreakoutError(
      `refId ${t.refId}: tagBreakout isn't supported for Prometheus/PromQL targets yet (tracked in issue #127). ` +
        'It currently applies only to builder-mode InfluxQL targets.',
    );
  }
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
        'InfluxQL "measurement", no PromQL "expr"). Only builder-mode InfluxQL targets are supported.',
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
  assertBreakoutSupported(target.raw);
  const raw: PanelTarget = { ...target.raw };
  if (breakout.value !== undefined) {
    raw.tags = addTagFilter(raw.tags, breakout.key, breakout.value);
  } else {
    raw.groupBy = addGroupByTag(raw.groupBy, breakout.key);
  }
  return { ...target, raw };
}
