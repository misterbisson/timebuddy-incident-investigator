import type { PanelTarget } from '../grafana/types.js';

export interface ExtractedQueryInfo {
  metricNames: string[];
  /** label/tag key -> observed values (deduped) referenced in the query's filters. */
  labels: Record<string, string[]>;
}

const PROMQL_KEYWORDS = new Set([
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'offset', 'bool',
  'and', 'or', 'unless', 'sum', 'min', 'max', 'avg', 'stddev', 'stdvar', 'count',
  'count_values', 'bottomk', 'topk', 'quantile', 'rate', 'irate', 'increase',
  'delta', 'idelta', 'deriv', 'predict_linear', 'histogram_quantile', 'label_replace',
  'label_join', 'abs', 'ceil', 'floor', 'round', 'clamp', 'clamp_max', 'clamp_min',
  'sort', 'sort_desc', 'scalar', 'vector', 'time', 'timestamp',
]);

function addLabel(labels: Record<string, string[]>, key: string, value: string): void {
  const list = (labels[key] ??= []);
  if (!list.includes(value)) list.push(value);
}

/**
 * Best-effort PromQL scan: not a full parser, but enough to build a metric
 * name -> dashboard reverse index. Metric names are tokens immediately
 * followed by a label selector `{...}`, plus any bare identifier that isn't
 * a known PromQL function/aggregation keyword.
 */
export function extractFromPromQL(expr: string): ExtractedQueryInfo {
  const metricNames = new Set<string>();
  const labels: Record<string, string[]> = {};

  const withSelectorPattern = /([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{/g;
  for (const match of expr.matchAll(withSelectorPattern)) {
    metricNames.add(match[1]!);
  }

  // Ranges covered by by(...)/without(...)/on(...)/ignoring(...) hold label
  // names, not metric names — exclude them from the bare-identifier scan.
  const groupingRanges: Array<[number, number]> = [];
  const groupingPattern = /\b(?:by|without|on|ignoring|group_left|group_right)\s*\(([^)]*)\)/gi;
  for (const match of expr.matchAll(groupingPattern)) {
    groupingRanges.push([match.index!, match.index! + match[0].length]);
  }
  const insideGrouping = (index: number) => groupingRanges.some(([start, end]) => index >= start && index < end);

  // Matched as whole-word identifiers (not via a backtracking-prone negative
  // lookahead, which can otherwise match a truncated prefix like "su" out of
  // "sum(") — instead, check what follows a full match in the source string.
  const identifierPattern = /\b[a-zA-Z_:][a-zA-Z0-9_:]*\b/g;
  for (const match of expr.matchAll(identifierPattern)) {
    const name = match[0];
    const index = match.index!;
    if (insideGrouping(index)) continue;
    if (/^\d/.test(name)) continue;
    if (PROMQL_KEYWORDS.has(name.toLowerCase())) continue;
    const followedByParen = /^\s*\(/.test(expr.slice(index + name.length));
    if (followedByParen) continue;
    metricNames.add(name);
  }

  const labelMatcherPattern = /([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=~|!~|=|!=)\s*"([^"]*)"/g;
  for (const match of expr.matchAll(labelMatcherPattern)) {
    const [, key, value] = match;
    if (key === '__name__') continue;
    addLabel(labels, key!, value!);
  }

  return { metricNames: [...metricNames], labels };
}

function lastSegment(measurement: string): string {
  const parts = measurement.split('.').map((p) => p.replace(/^"|"$/g, ''));
  return parts.at(-1) ?? measurement;
}

export function extractFromInfluxQL(target: PanelTarget): ExtractedQueryInfo {
  const metricNames = new Set<string>();
  const labels: Record<string, string[]> = {};

  // Grafana's InfluxQL editor stores two independently-edited representations
  // per target — the structured builder fields (measurement/tags/...) and a
  // raw Text-mode `query` string — and only one is ever executed, selected by
  // `rawQuery`. The other can go stale forever (edited once in one mode,
  // never regenerated in the other), so it must not be read as if it were
  // live (see #35: a stale, wrong-platform query survived unnoticed in a
  // builder-mode panel and was briefly mistaken for a real bug). When
  // `rawQuery` itself is absent (older dashboards saved before Grafana
  // tracked it), fall back to reading whatever fields are present, since
  // there's no way to tell which mode produced them.
  const readBuilderFields = target.rawQuery !== true;
  const readTextQuery = target.rawQuery !== false;

  if (readBuilderFields) {
    if (target.measurement) {
      metricNames.add(lastSegment(target.measurement));
    }
    for (const tag of target.tags ?? []) {
      addLabel(labels, tag.key, tag.value);
    }
  }

  if (readTextQuery && target.query) {
    const segment = '(?:"[^"]+"|[a-zA-Z0-9_]+)';
    const fromMatch = target.query.match(new RegExp(`from\\s+(?:\\(\\s*)?(${segment}(?:\\.${segment})*)`, 'i'));
    if (fromMatch) metricNames.add(lastSegment(fromMatch[1]!));

    const whereClauseMatch = target.query.match(/\bwhere\b(.+?)(\bgroup by\b|\border by\b|\blimit\b|$)/is);
    if (whereClauseMatch) {
      const tagPattern = /"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*=\s*'([^']*)'/g;
      for (const match of whereClauseMatch[1]!.matchAll(tagPattern)) {
        addLabel(labels, match[1]!, match[2]!);
      }
    }
  }

  return { metricNames: [...metricNames], labels };
}

/** Dispatches to the Prometheus or InfluxQL extractor based on which fields the target carries. */
export function extractQueryInfo(target: PanelTarget): ExtractedQueryInfo {
  if (typeof target.expr === 'string') return extractFromPromQL(target.expr);
  if (target.measurement || typeof target.query === 'string') return extractFromInfluxQL(target);
  return { metricNames: [], labels: {} };
}
