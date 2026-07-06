import type { PanelTarget, TemplateVariable } from '../grafana/types.js';

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
 * otherwise fall back to the dashboard's saved `current.value`.
 */
export function effectiveValues(variable: TemplateVariable, overrides: Record<string, string[]>): string[] {
  const override = overrides[variable.name];
  if (override && override.length > 0) return override;

  const current = variable.current?.value;
  if (current === undefined) return [];
  const values = Array.isArray(current) ? current : [current];

  if (values.includes('$__all')) {
    if (variable.allValue) return [variable.allValue];
    return (variable.options ?? []).map((o) => o.value).filter((v) => v !== '$__all');
  }
  return values;
}

function formatValues(values: string[], format: string | undefined): string {
  if (values.length === 0) return '';
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
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function humanDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** Picks a "nice" step interval, mirroring Grafana's $__interval heuristic. */
function computeInterval(window: QueryWindow, maxDataPoints = 1000): string {
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
): string {
  let result = query;

  result = result
    .replaceAll('$__interval', computeInterval(window))
    .replaceAll('${__interval}', computeInterval(window))
    .replaceAll('$__range', humanDuration(window.toMs - window.fromMs))
    .replaceAll('${__range}', humanDuration(window.toMs - window.fromMs))
    .replaceAll('$__from', String(window.fromMs))
    .replaceAll('${__from}', String(window.fromMs))
    .replaceAll('$__to', String(window.toMs))
    .replaceAll('${__to}', String(window.toMs))
    .replaceAll('$timeFilter', `time >= ${window.fromMs}ms and time <= ${window.toMs}ms`);

  // Longest names first so "$service_name" isn't partially matched by "$service".
  const sorted = [...variables].sort((a, b) => b.name.length - a.name.length);
  for (const variable of sorted) {
    const values = effectiveValues(variable, overrides);
    const braceFormatPattern = new RegExp(`\\$\\{${variable.name}(?::([a-zA-Z]+))?\\}`, 'g');
    result = result.replace(braceFormatPattern, (_m, format?: string) => formatValues(values, format));
    result = result.replaceAll(`[[${variable.name}]]`, formatValues(values, undefined));
    const simplePattern = new RegExp(`\\$${variable.name}\\b`, 'g');
    result = result.replace(simplePattern, () => formatValues(values, undefined));
  }

  return result;
}

/** Applies substituteVariables to a target's query-string fields (`expr` for Prometheus, `query` for InfluxQL). */
export function substituteTargetFields(
  raw: PanelTarget,
  variables: TemplateVariable[],
  overrides: Record<string, string[]>,
  window: QueryWindow,
): PanelTarget {
  const substituted: PanelTarget = { ...raw };
  if (typeof raw.expr === 'string') {
    substituted.expr = substituteVariables(raw.expr, variables, overrides, window);
  }
  if (typeof raw.query === 'string') {
    substituted.query = substituteVariables(raw.query, variables, overrides, window);
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
