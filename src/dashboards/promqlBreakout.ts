/**
 * Best-effort PromQL rewriting for tagBreakout's Prometheus half (#131).
 * Deliberately not a real parser — same "best-effort regex scan" posture as
 * index-builder/extract.ts — but string-literal-aware: every quoted string's
 * interior (label values, label_replace() args, etc.) is masked out before
 * any structural regex runs, so quoted text can never be mistaken for a
 * metric name, aggregation keyword, or label. Any expression shape this
 * can't confidently rewrite throws RewriteFailure rather than silently
 * returning an unmodified or partially-rewritten query — tagBreakout.ts
 * turns that into the same hard-error contract InfluxQL targets get.
 */

export class RewriteFailure extends Error {}

const AGGREGATION_KEYWORDS = [
  'sum', 'min', 'max', 'avg', 'group', 'stddev', 'stdvar',
  'count', 'count_values', 'bottomk', 'topk', 'quantile',
] as const;

// Not exhaustive PromQL grammar — just enough to tell "this identifier is a
// function/operator, not a metric or label name" so the bare-selector scan
// below doesn't mistake e.g. "and"/"rate" for a metric. Mirrors
// index-builder/extract.ts's PROMQL_KEYWORDS, plus the aggregation ops.
const NON_METRIC_KEYWORDS = new Set([
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'offset', 'bool',
  'and', 'or', 'unless',
  ...AGGREGATION_KEYWORDS,
  'rate', 'irate', 'increase', 'delta', 'idelta', 'deriv', 'predict_linear',
  'histogram_quantile', 'label_replace', 'label_join', 'abs', 'ceil', 'floor',
  'round', 'clamp', 'clamp_max', 'clamp_min', 'sort', 'sort_desc', 'scalar',
  'vector', 'time', 'timestamp', 'exp', 'ln', 'log2', 'log10', 'sqrt',
  'day_of_month', 'day_of_week', 'day_of_year', 'days_in_month', 'hour',
  'minute', 'month', 'year', 'changes', 'resets', 'holt_winters',
]);

const VALID_LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * A PromQL label name is embedded RAW (never quoted) into both a `{key=...}`
 * matcher and a `by (key)` clause — unlike the label *value*, which is
 * escaped into a quoted string below, there is no quoting layer protecting
 * an unvalidated key. This is the injection-safety boundary #131 exists to
 * take seriously: refuse anything that isn't a plain identifier rather than
 * splice arbitrary text into query syntax.
 */
function assertValidLabelName(key: string): void {
  if (!VALID_LABEL_NAME.test(key)) {
    throw new RewriteFailure(
      `"${key}" isn't a valid PromQL label name (must match ${VALID_LABEL_NAME}) — refusing to inject it into query text`,
    );
  }
}

function escapePromqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescapePromqlString(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/**
 * Replaces every quoted string literal's interior with '#' placeholders of
 * the same length (honoring backslash escapes), so positions/length exactly
 * match the original — match indices found against the masked string are
 * valid offsets into the original — while no quoted text can match any
 * metric/label/keyword regex below. Returns null for an unterminated string
 * (malformed PromQL we refuse to touch).
 */
function maskStrings(expr: string): string | null {
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"' || c === "'") {
      const quote = c;
      out += '#';
      i++;
      let closed = false;
      while (i < expr.length) {
        if (expr[i] === '\\' && i + 1 < expr.length) {
          out += '##';
          i += 2;
          continue;
        }
        if (expr[i] === quote) {
          out += '#';
          i++;
          closed = true;
          break;
        }
        out += '#';
        i++;
      }
      if (!closed) return null;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Index of the ')' matching the '(' at openIndex, or -1 if unbalanced. */
function findMatchingParen(mask: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < mask.length; i++) {
    if (mask[i] === '(') depth++;
    else if (mask[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

type Range = [number, number];

function withinAny(ranges: Range[], index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** Spans of by(...)/without(...)/on(...)/ignoring(...)/group_left(...)/group_right(...) label lists — their contents are label names, never metric names. Non-nested paren content, matching extract.ts's same simplification. */
function findGroupingRanges(mask: string): Range[] {
  const ranges: Range[] = [];
  const pattern = /\b(?:by|without|on|ignoring|group_left|group_right)\s*\(([^)]*)\)/gi;
  for (const m of mask.matchAll(pattern)) {
    ranges.push([m.index!, m.index! + m[0].length]);
  }
  return ranges;
}

/** Spans of every `{...}` label-matcher block. Label matcher blocks don't nest, so the first literal '}' after '{' is always the close — masking already guarantees no '{'/'}' survives inside a quoted string. */
function findBraceRanges(mask: string): Range[] {
  const ranges: Range[] = [];
  let i = 0;
  while (i < mask.length) {
    if (mask[i] === '{') {
      const close = mask.indexOf('}', i);
      if (close === -1) throw new RewriteFailure('contains an unclosed "{" — a label matcher block is never closed');
      ranges.push([i, close + 1]);
      i = close + 1;
      continue;
    }
    i++;
  }
  return ranges;
}

interface Selector {
  /** Index right after the metric-name identifier's text. */
  nameEnd: number;
  /** Set when the identifier is immediately followed by a `{...}` block. */
  braceRange?: Range;
}

function findSelectors(mask: string): Selector[] {
  const braceRanges = findBraceRanges(mask);
  const groupingRanges = findGroupingRanges(mask);
  const selectors: Selector[] = [];
  const identifierPattern = /\b[a-zA-Z_:][a-zA-Z0-9_:]*\b/g;
  for (const m of mask.matchAll(identifierPattern)) {
    const name = m[0];
    const start = m.index!;
    const end = start + name.length;
    if (withinAny(groupingRanges, start)) continue; // a label name inside by/without/on/ignoring(...), not a metric
    if (withinAny(braceRanges, start)) continue; // a label key inside someone else's {...}, not a metric
    if (NON_METRIC_KEYWORDS.has(name.toLowerCase())) continue;
    const wsLen = mask.slice(end).match(/^\s*/)![0].length;
    const afterWs = end + wsLen;
    if (mask[afterWs] === '(') continue; // a function/aggregation call, not a selector
    const brace = braceRanges.find(([braceStart]) => braceStart === afterWs);
    selectors.push({ nameEnd: end, braceRange: brace });
  }
  return selectors;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(text: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

const LABEL_MATCHER_PATTERN = /([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * Injects a `key="value"` matcher into every vector selector in `expr`. A
 * selector that already constrains `key` to this exact value is left alone
 * (idempotent); one that constrains it to something else throws rather than
 * silently overriding an existing, possibly-intentional filter.
 */
export function applyPromqlFilter(expr: string, key: string, value: string): string {
  assertValidLabelName(key);
  const mask = maskStrings(expr);
  if (mask === null) throw new RewriteFailure('contains an unterminated quoted string');
  const selectors = findSelectors(mask);
  if (selectors.length === 0) {
    throw new RewriteFailure('no metric selector found to filter (no bare or braced vector selector in this expression)');
  }
  const escaped = escapePromqlString(value);
  const edits: Edit[] = [];
  for (const sel of selectors) {
    if (!sel.braceRange) {
      edits.push({ start: sel.nameEnd, end: sel.nameEnd, text: `{${key}="${escaped}"}` });
      continue;
    }
    const [braceStart, braceEnd] = sel.braceRange;
    const inner = expr.slice(braceStart + 1, braceEnd - 1);
    let conflict = false;
    let alreadyPresent = false;
    for (const mm of inner.matchAll(LABEL_MATCHER_PATTERN)) {
      if (mm[1] !== key) continue;
      if (mm[2] === '=' && unescapePromqlString(mm[3]!) === value) alreadyPresent = true;
      else conflict = true;
    }
    if (conflict) {
      throw new RewriteFailure(`label "${key}" is already constrained to a different value in an existing selector — refusing to override it`);
    }
    if (alreadyPresent) continue;
    const trimmedInner = inner.trim();
    const insertion = trimmedInner.length === 0 ? `${key}="${escaped}"` : `,${key}="${escaped}"`;
    edits.push({ start: braceEnd - 1, end: braceEnd - 1, text: insertion });
  }
  return applyEdits(expr, edits);
}

interface AggMatch {
  kind: 'by' | 'without' | 'none';
  labelsStart?: number;
  labelsEnd?: number;
  insertAt?: number;
}

function parseModifierClause(mask: string, afterKeywordPos: number): { kind: 'by' | 'without'; labelsStart: number; labelsEnd: number } | undefined {
  const modWord = mask.slice(afterKeywordPos).match(/^(by|without)\b/i);
  if (!modWord) return undefined;
  const kind = modWord[1]!.toLowerCase() as 'by' | 'without';
  let pos = afterKeywordPos + modWord[0].length;
  pos += mask.slice(pos).match(/^\s*/)![0].length;
  if (mask[pos] !== '(') {
    throw new RewriteFailure(`expected "(" after "${modWord[1]}"`);
  }
  const labelsStart = pos + 1;
  const closeIdx = mask.indexOf(')', labelsStart);
  if (closeIdx === -1) throw new RewriteFailure('unbalanced "(" in a by/without clause');
  return { kind, labelsStart, labelsEnd: closeIdx };
}

function findAggregations(mask: string): AggMatch[] {
  const matches: AggMatch[] = [];
  const groupingRanges = findGroupingRanges(mask);
  const keywordPattern = new RegExp(`\\b(${AGGREGATION_KEYWORDS.join('|')})\\b`, 'gi');
  for (const km of mask.matchAll(keywordPattern)) {
    const kwStart = km.index!;
    const kwEnd = kwStart + km[0].length;
    if (withinAny(groupingRanges, kwStart)) continue; // a label literally named e.g. "sum" inside someone else's by/without(...)

    let pos = kwEnd;
    pos += mask.slice(pos).match(/^\s*/)![0].length;

    const prefixModifier = parseModifierClause(mask, pos);
    if (prefixModifier) {
      let p = prefixModifier.labelsEnd + 1;
      p += mask.slice(p).match(/^\s*/)![0].length;
      if (mask[p] !== '(') {
        throw new RewriteFailure(`expected the aggregated expression's "(" after the "${prefixModifier.kind}" clause`);
      }
      if (findMatchingParen(mask, p) === -1) throw new RewriteFailure('unbalanced parentheses in an aggregation expression');
      matches.push({ kind: prefixModifier.kind, labelsStart: prefixModifier.labelsStart, labelsEnd: prefixModifier.labelsEnd });
      continue;
    }

    if (mask[pos] !== '(') continue; // keyword used as e.g. a metric/label name, not an aggregation call
    const exprClose = findMatchingParen(mask, pos);
    if (exprClose === -1) throw new RewriteFailure('unbalanced parentheses in an aggregation expression');

    let after = exprClose + 1;
    after += mask.slice(after).match(/^\s*/)![0].length;
    const postfixModifier = parseModifierClause(mask, after);
    if (postfixModifier) {
      matches.push({ kind: postfixModifier.kind, labelsStart: postfixModifier.labelsStart, labelsEnd: postfixModifier.labelsEnd });
      continue;
    }
    matches.push({ kind: 'none', insertAt: kwEnd });
  }
  return matches;
}

/**
 * Injects `by (key)` into every aggregation operator in `expr` so an
 * aggregated panel splits into one series per `key` value. An aggregation
 * that already groups by `key` (via `by`) is left alone; one that excludes
 * it via `without` has `key` removed from the exclusion list (which is what
 * makes it appear as its own series); one already NOT excluding `key` via
 * `without` is already implicitly broken out and is left alone too.
 */
export function applyPromqlGroupBy(expr: string, key: string): string {
  assertValidLabelName(key);
  const mask = maskStrings(expr);
  if (mask === null) throw new RewriteFailure('contains an unterminated quoted string');
  const aggregations = findAggregations(mask);
  if (aggregations.length === 0) {
    throw new RewriteFailure(
      'no aggregation operator (sum/avg/max/...) found — this expression already returns one series per label set, so there is nothing to break out',
    );
  }
  const edits: Edit[] = [];
  for (const agg of aggregations) {
    if (agg.kind === 'none') {
      edits.push({ start: agg.insertAt!, end: agg.insertAt!, text: ` by (${key}) ` });
      continue;
    }
    const inner = expr.slice(agg.labelsStart!, agg.labelsEnd!);
    const labels = inner
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (agg.kind === 'without') {
      const idx = labels.indexOf(key);
      if (idx === -1) continue; // not excluded => already broken out implicitly
      labels.splice(idx, 1);
      edits.push({ start: agg.labelsStart!, end: agg.labelsEnd!, text: labels.join(', ') });
    } else {
      if (labels.includes(key)) continue; // idempotent
      const text = labels.length === 0 ? key : `${inner.trim()}, ${key}`;
      edits.push({ start: agg.labelsStart!, end: agg.labelsEnd!, text });
    }
  }
  return applyEdits(expr, edits);
}
