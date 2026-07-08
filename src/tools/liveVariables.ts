import type { GrafanaClient } from '../grafana/client.js';
import type { DatasourceInfo, DsQueryResponse, TemplateVariable } from '../grafana/types.js';
import { effectiveValues, resolveDatasourceVariable, substituteVariables, type QueryWindow } from '../dashboards/variables.js';

export interface MaterializedVariables {
  /** Original overrides merged with any live-resolved values — pass straight into substituteTargetFields/resolveTargetDatasource. */
  overrides: Record<string, string[]>;
  /** Variable names still falling open to the unconstrained '.*' — unsupported datasource/query shape, a failed live query, or a live query that returned nothing. */
  unresolvedAllVariables: string[];
}

const SHOW_TAG_VALUES_PATTERN = /^\s*SHOW TAG VALUES/i;

function requestedAll(variable: TemplateVariable, overrides: Record<string, string[]>): boolean {
  const override = overrides[variable.name];
  if (override && override.length > 0) return override.includes('$__all');
  const current = variable.current?.value;
  if (current === undefined) return false;
  return Array.isArray(current) ? current.includes('$__all') : current === '$__all';
}

function queryText(variable: TemplateVariable): string | undefined {
  if (typeof variable.query === 'string') return variable.query;
  return variable.query?.query;
}

async function resolveVariableDatasource(
  client: GrafanaClient,
  variable: TemplateVariable,
  variables: TemplateVariable[],
  overrides: Record<string, string[]>,
  datasourcesCache: { list?: DatasourceInfo[] },
): Promise<{ uid: string; type?: string } | undefined> {
  const ds = variable.datasource;
  if (!ds) return undefined;

  const listDatasourcesOnce = async (): Promise<DatasourceInfo[]> => {
    datasourcesCache.list ??= await client.listDatasources();
    return datasourcesCache.list;
  };

  if (typeof ds === 'string') {
    // resolveDatasourceVariable only resolves "$name"-style variable refs (returning
    // either a uid or a legacy datasource name, pure/sync — no fetch); a plain string
    // is already a uid-or-name as-is. Either way, look it up through the one shared
    // listDatasourcesOnce() below rather than a second, separate fetch.
    const ref = ds.startsWith('$') ? resolveDatasourceVariable(ds, variables, overrides) : ds;
    if (!ref) return undefined;
    const list = await listDatasourcesOnce();
    const info = list.find((d) => d.uid === ref) ?? list.find((d) => d.name === ref);
    return info ? { uid: info.uid, type: info.type } : { uid: ref, type: undefined };
  }
  if (ds.type) return { uid: ds.uid, type: ds.type };
  const info = (await listDatasourcesOnce()).find((d) => d.uid === ds.uid);
  return { uid: ds.uid, type: info?.type };
}

/** Extracts distinct string values from a "SHOW TAG VALUES"-shaped response — Grafana's standard key/value column pair, not tied to any particular measurement/schema. */
function extractTagValues(response: DsQueryResponse): string[] {
  const values = new Set<string>();
  for (const result of Object.values(response.results)) {
    if (result.error) continue;
    for (const frame of result.frames ?? []) {
      const valueIdx = frame.schema.fields.findIndex((f) => f.name.toLowerCase() === 'value');
      if (valueIdx === -1) continue;
      for (const v of frame.data.values[valueIdx] ?? []) {
        if (typeof v === 'string') values.add(v);
      }
    }
  }
  return [...values];
}

/** Mirrors Grafana's own query-variable post-processing: extract capture group 1 if the regex has one, else the full match; values with no match are dropped. */
/** Grafana stores a query variable's regex delimited as "/pattern/flags" (like its own regex-format values); a bare pattern with no delimiters is accepted too, for hand-authored dashboards. */
function parseVariableRegex(regex: string): RegExp {
  const delimited = regex.match(/^\/(.*)\/([a-z]*)$/);
  return delimited ? new RegExp(delimited[1]!, delimited[2]) : new RegExp(regex);
}

function applyVariableRegex(values: string[], regex: string | undefined): string[] {
  if (!regex) return values;
  const pattern = parseVariableRegex(regex);
  const out: string[] = [];
  for (const value of values) {
    const match = value.match(pattern);
    if (!match) continue;
    out.push(match[1] ?? match[0]);
  }
  return out;
}

/**
 * Live-resolves query-type variables that would otherwise fall open to '.*'
 * (see dashboards/variables.ts's formatValues doc comment) — the one
 * concrete case confirmed in practice: an InfluxQL variable whose option
 * list Grafana computes live via "SHOW TAG VALUES" and never persists into
 * the saved dashboard JSON. Everything else (explicit overrides, a
 * non-"$__all" current value, non-query variable types, unsupported
 * datasources/query shapes, a failed or empty live query) is left exactly as
 * effectiveValues/formatValues already handle it today — this only ever adds
 * information, never removes the existing fallback.
 */
export async function materializeVariables(
  client: GrafanaClient,
  variables: TemplateVariable[],
  overrides: Record<string, string[]>,
  window: QueryWindow,
): Promise<MaterializedVariables> {
  const resultOverrides: Record<string, string[]> = { ...overrides };
  const unresolvedAllVariables: string[] = [];
  const datasourcesCache: { list?: DatasourceInfo[] } = {};

  for (const variable of variables) {
    // Only act on the specific path that falls open to '.*' today (see
    // formatValues in variables.ts): nothing else is touched, so this can never
    // change behavior for a variable that already resolves fine.
    if (effectiveValues(variable, overrides).length > 0) continue;
    if (!requestedAll(variable, overrides)) continue;

    if (variable.type !== 'query') {
      unresolvedAllVariables.push(variable.name);
      continue;
    }

    const query = queryText(variable);
    if (!query || !SHOW_TAG_VALUES_PATTERN.test(query)) {
      unresolvedAllVariables.push(variable.name);
      continue;
    }

    const datasource = await resolveVariableDatasource(client, variable, variables, overrides, datasourcesCache);
    if (!datasource || datasource.type !== 'influxdb') {
      unresolvedAllVariables.push(variable.name);
      continue;
    }

    try {
      const substitutedQuery = substituteVariables(query, variables, overrides, window);
      const response = await client.queryDs({
        from: String(window.fromMs),
        to: String(window.toMs),
        queries: [{ refId: 'variable', datasource: { uid: datasource.uid }, query: substitutedQuery, rawQuery: true }],
      });
      const values = applyVariableRegex(extractTagValues(response), variable.regex);
      if (values.length === 0) {
        unresolvedAllVariables.push(variable.name);
        continue;
      }
      resultOverrides[variable.name] = values;
    } catch {
      unresolvedAllVariables.push(variable.name);
    }
  }

  return { overrides: resultOverrides, unresolvedAllVariables };
}
