import type { PanelTarget, TemplateVariable } from '../grafana/types.js';
import { DEFAULT_MAX_DATA_POINTS } from '../config.js';

export interface QueryWindow {
  fromMs: number;
  toMs: number;
  /** Suggested step for $__interval, in milliseconds. */
  intervalMs?: number;
}

/**
 * Resolves the effective value(s) for one variable: an explicit override
 * (e.g. captured from the `var-*` params of the panel URL an alert linked
 * to — what a human clicking the link would actually have seen) wins;
 * otherwise fall back to the dashboard's saved `current.value`. Either
 * source can carry the literal `$__all` sentinel — a URL built by Grafana
 * itself for a multi-value variable with "Include All" selected renders as
 * `var-name=$__all`, not as every individual option — so both are expanded
 * the same way: to the variable's configured allValue, else its cached
 * option list. (Confirmed against a real incident: before this expanded
 * override values too, an alert URL with `var-host=$__all` sent the literal
 * string "$__all" into the replayed query, which every real datasource
 * predictably matched nothing against — this tool reported "no data" over a
 * live, ongoing outage the dashboard itself showed clearly.)
 */
export function effectiveValues(variable: TemplateVariable, overrides: Record<string, string[]>): string[] {
  const override = overrides[variable.name];
  const current = variable.current?.value;
  const values = override && override.length > 0 ? override : current === undefined ? [] : Array.isArray(current) ? current : [current];

  if (values.includes('$__all')) {
    if (variable.allValue) return [variable.allValue];
    return (variable.options ?? []).map((o) => o.value).filter((v) => v !== '$__all');
  }
  return values;
}

function formatValues(values: string[], format: string | undefined): string {
  if (values.length === 0) {
    // Only reachable via an unresolved "All" selection in effectiveValues:
    // no explicit allValue, and no options cached in the dashboard's saved
    // JSON (common for query-type variables, whose options Grafana populates
    // live at render time rather than storing). The default/regex formats
    // build an alternation meant to sit inside the datasource's own regex
    // matcher (InfluxQL's `/^$host$/`, PromQL's `label=~"$service"`); leaving
    // it empty produces an anchored empty-string match that silently zeroes
    // out every result. Confirmed against a real incident: this masked a live
    // outage as "no data" on every panel of an affected dashboard. Failing
    // open (match everything) is far safer here than failing closed (match
    // nothing) for an incident-investigation tool. Other formats (csv/json/
    // sqlstring/pipe/lucene) aren't naturally regex contexts, so they're left
    // as '' rather than guessing at wildcard syntax that may not apply there.
    return format === undefined || format === 'regex' ? '.*' : '';
  }
  switch (format) {
    case 'csv':
      return values.join(',');
    case 'json':
      return JSON.stringify(values.length === 1 ? values[0] : values);
    case 'pipe':
      return values.join('|');
    case 'regex':
      return values.length === 1 ? escapeRegex(values[0]!) : `(${values.map(escapeRegex).join('|')})`;
    case 'sqlstring':
      return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',');
    case 'lucene':
      return values.length === 1 ? values[0]! : `(${values.join(' OR ')})`;
    default:
      // Grafana's default multi-value behavior for query strings: a single
      // value is inserted raw; multiple values become a regex alternation,
      // which is what most PromQL/InfluxQL label matchers expect.
      return values.length === 1 ? values[0]! : `(${values.map(escapeRegex).join('|')})`;
  }
}

function escapeRegex(value: string): string {
  // The `$&` here is the one deliberate pattern reference in this file: it
  // re-emits the matched regex metacharacter with a backslash prefix, which is
  // the whole point of escaping. Every actual value substitution above uses a
  // replacement function precisely so no value can be reinterpreted this way
  // (see #86 / #65).
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function humanDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * Picks a "nice" step interval, mirroring Grafana's $__interval heuristic.
 * Real Grafana derives this from the rendered panel's pixel width; this tool
 * has no panel to measure, so it approximates the same "big display" width
 * real users see by using the same point budget (maxDataPoints) actually
 * sent to /api/ds/query for this query — passed in by every caller so the
 * two stay in sync (see #53; they previously used different hardcoded
 * numbers, so the interval baked into query text was coarser than what the
 * request itself asked for).
 */
function computeInterval(window: QueryWindow, maxDataPoints = DEFAULT_MAX_DATA_POINTS): string {
  if (window.intervalMs) return humanDuration(window.intervalMs);
  const spanMs = window.toMs - window.fromMs;
  const rawStepMs = spanMs / maxDataPoints;
  const steps = [1000, 5000, 10000, 30000, 60000, 300000, 600000, 1800000, 3600000, 21600000, 86400000];
  const step = steps.find((s) => s >= rawStepMs) ?? steps.at(-1)!;
  return humanDuration(step);
}

/**
 * Substitutes `$name`, `${name}`, `${name:format}`, and `[[name]]` variable
 * references plus Grafana's built-in time macros (`$__interval`, `$__range`,
 * `$__from`, `$__to`, `$timeFilter`) in a query string.
 */
export function substituteVariables(
  query: string,
  variables: TemplateVariable[],
  overrides: Record<string, string[]>,
  window: QueryWindow,
  maxDataPoints?: number,
): string {
  let result = query;

  // Invariant: every substitution in this file supplies its replacement as a
  // *function*, never a raw string. A string replacement reinterprets `$&`,
  // `$'`, `` $` `` and `$1` in the value as match-pattern references (the class
  // of bug fixed for user-variable values in #65). These built-in values are
  // all `$`-free today — computeInterval/humanDuration return digits plus a
  // unit letter, $__from/$__to are String() of a number, $timeFilter is built
  // from those — so this is invariant-keeping, not a live fix. But "no
  // substitution here uses a string replacement" is a rule the next reader can
  // grep and trust, where re-checking each value's provenance by hand is
  // exactly the step skipped before #65. The one deliberate `$&` is
  // escapeRegex's, commented at its definition.
  const interval = computeInterval(window, maxDataPoints);
  const range = humanDuration(window.toMs - window.fromMs);
  const from = String(window.fromMs);
  const to = String(window.toMs);
  const timeFilter = `time >= ${window.fromMs}ms and time <= ${window.toMs}ms`;
  result = result
    .replaceAll('$__interval', () => interval)
    .replaceAll('${__interval}', () => interval)
    .replaceAll('$__range', () => range)
    .replaceAll('${__range}', () => range)
    .replaceAll('$__from', () => from)
    .replaceAll('${__from}', () => from)
    .replaceAll('$__to', () => to)
    .replaceAll('${__to}', () => to)
    .replaceAll('$timeFilter', () => timeFilter);

  // Longest names first so "$service_name" isn't partially matched by "$service".
  const sorted = [...variables].sort((a, b) => b.name.length - a.name.length);
  for (const variable of sorted) {
    const values = effectiveValues(variable, overrides);
    const braceFormatPattern = new RegExp(`\\$\\{${variable.name}(?::([a-zA-Z]+))?\\}`, 'g');
    result = result.replace(braceFormatPattern, (_m, format?: string) => formatValues(values, format));
    // Replacement *function*, matching the two forms around it: a plain string
    // replacement interprets `$'`, `` $` ``, `$&` and `$1` as patterns, so a
    // variable value containing one would rewrite the surrounding query rather
    // than being inserted literally.
    result = result.replaceAll(`[[${variable.name}]]`, () => formatValues(values, undefined));
    const simplePattern = new RegExp(`\\$${variable.name}\\b`, 'g');
    result = result.replace(simplePattern, () => formatValues(values, undefined));
  }

  return result;
}

/**
 * Applies substituteVariables to a target's query-string fields (`expr` for
 * Prometheus, `query` for raw-mode InfluxQL) as well as the string fields of
 * InfluxQL's structured query builder (`measurement`, `policy`, and each
 * `tags[].value`) — a builder-mode tag filter like `/^$host$/` embeds the
 * variable reference inside a larger string rather than being the whole
 * field, so it needs the same substitution pass, not just a straight
 * override lookup.
 */
export function substituteTargetFields(
  raw: PanelTarget,
  variables: TemplateVariable[],
  overrides: Record<string, string[]>,
  window: QueryWindow,
  maxDataPoints?: number,
): PanelTarget {
  const substituted: PanelTarget = { ...raw };
  if (typeof raw.expr === 'string') {
    substituted.expr = substituteVariables(raw.expr, variables, overrides, window, maxDataPoints);
  }
  if (typeof raw.query === 'string') {
    substituted.query = substituteVariables(raw.query, variables, overrides, window, maxDataPoints);
  }
  if (typeof raw.measurement === 'string') {
    substituted.measurement = substituteVariables(raw.measurement, variables, overrides, window, maxDataPoints);
  }
  if (typeof raw.policy === 'string') {
    substituted.policy = substituteVariables(raw.policy, variables, overrides, window, maxDataPoints);
  }
  if (Array.isArray(raw.tags)) {
    substituted.tags = raw.tags.map((tag) => ({
      ...tag,
      value: substituteVariables(tag.value, variables, overrides, window, maxDataPoints),
    }));
  }
  return substituted;
}

/** Merges `var-*` overrides from a panel URL with a variable name -> values map. */
export function mergeVariableOverrides(...sources: Array<Record<string, string[]> | undefined>): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [k, v] of Object.entries(source)) merged[k] = v;
  }
  return merged;
}

/** Extracts the variable name from a `$name` / `${name}` / `${name:format}` reference, or undefined if it isn't one. */
function templateVariableName(ref: string): string | undefined {
  return (ref.match(/^\$\{([a-zA-Z0-9_]+)(?::[a-zA-Z]+)?\}$/) ?? ref.match(/^\$([a-zA-Z0-9_]+)$/))?.[1];
}

/**
 * Resolves a panel/target's datasource reference when it's a Grafana
 * datasource-picker template variable ($datasource, ${DS_PROMETHEUS}, ...)
 * rather than a fixed UID. Grafana resolves this at render time from the
 * variable's current selection; without doing the same, the literal
 * variable-reference string gets sent to /api/ds/query verbatim and Grafana
 * rejects it with "404 Data source not found".
 *
 * Returns the ref unchanged if it isn't a variable reference (nothing to
 * resolve — this covers both a real UID and a legacy literal datasource
 * name, neither of which this function can tell apart from each other).
 * Returns undefined if it IS a variable reference this dashboard doesn't
 * define, or one with no current value — an unresolvable reference, not a
 * guess.
 *
 * The resolved value may itself be a UID (modern Grafana) or a datasource
 * name (older Grafana) rather than a UID — callers with access to a
 * GrafanaClient should fall back to a name lookup via listDatasources() if
 * it doesn't match a known UID; see tools/shared.ts's resolveTargetDatasource.
 */
export function resolveDatasourceVariable(
  ref: string,
  variables: TemplateVariable[],
  overrides: Record<string, string[]>,
): string | undefined {
  const name = templateVariableName(ref);
  if (!name) return ref;
  const variable = variables.find((v) => v.name === name);
  if (!variable) return undefined;
  return effectiveValues(variable, overrides)[0];
}
