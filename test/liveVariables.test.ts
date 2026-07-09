import { describe, expect, it, vi } from 'vitest';
import { materializeVariables } from '../src/tools/liveVariables.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { DsQueryRequest, DsQueryResponse, TemplateVariable } from '../src/grafana/types.js';

const window = { fromMs: 1_700_000_000_000, toMs: 1_700_003_600_000 };

function tagValuesResponse(values: string[]): DsQueryResponse {
  return {
    results: {
      variable: {
        frames: [
          {
            schema: { fields: [{ name: 'key', type: 'string' }, { name: 'value', type: 'string' }] },
            data: { values: [values.map(() => 'target_host'), values] },
          },
        ],
      },
    },
  };
}

function fakeClient(opts: {
  queryDsResponse?: DsQueryResponse;
  queryDsError?: Error;
  datasources?: Array<{ uid: string; name: string; type: string }>;
}): { client: GrafanaClient; queryDs: ReturnType<typeof vi.fn>; listDatasources: ReturnType<typeof vi.fn> } {
  const queryDs = vi.fn(async (_req: DsQueryRequest) => {
    if (opts.queryDsError) throw opts.queryDsError;
    return opts.queryDsResponse ?? tagValuesResponse([]);
  });
  const listDatasources = vi.fn(async () => (opts.datasources ?? []).map((d, i) => ({ ...d, id: i + 1 })));
  return { client: { queryDs, listDatasources } as unknown as GrafanaClient, queryDs, listDatasources };
}

const influxDs = { uid: 'influx1', type: 'influxdb' };

function allSelectedVariable(overrides: Partial<TemplateVariable> = {}): TemplateVariable {
  return {
    name: 'unreachable_target_hosts',
    type: 'query',
    datasource: influxDs,
    query: 'SHOW TAG VALUES FROM "raw"."host_connectivity" WITH KEY = "target_host" WHERE $timeFilter',
    current: { value: '$__all' },
    ...overrides,
  };
}

describe('materializeVariables', () => {
  it('does not touch the client when the variable already has an explicit override', async () => {
    const { client, queryDs, listDatasources } = fakeClient({});
    const variable = allSelectedVariable();
    const result = await materializeVariables(client, [variable], { unreachable_target_hosts: ['h1'] }, window);
    expect(queryDs).not.toHaveBeenCalled();
    expect(listDatasources).not.toHaveBeenCalled();
    expect(result.overrides).toEqual({ unreachable_target_hosts: ['h1'] });
    expect(result.unresolvedAllVariables).toEqual([]);
  });

  it('does not touch the client when current value is not "$__all"', async () => {
    const { client, queryDs } = fakeClient({});
    const variable = allSelectedVariable({ current: { value: 'h1' } });
    const result = await materializeVariables(client, [variable], {}, window);
    expect(queryDs).not.toHaveBeenCalled();
    expect(result.unresolvedAllVariables).toEqual([]);
  });

  it('reports non-query variable types as unresolved rather than silently ignoring them', async () => {
    const { client, queryDs } = fakeClient({});
    const variable = allSelectedVariable({ type: 'custom' });
    const result = await materializeVariables(client, [variable], {}, window);
    expect(queryDs).not.toHaveBeenCalled();
    expect(result.unresolvedAllVariables).toEqual(['unreachable_target_hosts']);
  });

  it('live-resolves a "$__all" InfluxQL SHOW TAG VALUES variable and merges the real values into overrides', async () => {
    const { client, queryDs } = fakeClient({ queryDsResponse: tagValuesResponse(['h07-lab', 'h19-lab', 'h20-lab']) });
    const variable = allSelectedVariable();
    const result = await materializeVariables(client, [variable], {}, window);
    expect(result.overrides.unreachable_target_hosts).toEqual(['h07-lab', 'h19-lab', 'h20-lab']);
    expect(result.unresolvedAllVariables).toEqual([]);
    expect(queryDs).toHaveBeenCalledTimes(1);
    const req = queryDs.mock.calls[0]![0] as DsQueryRequest;
    expect(req.queries[0]!.datasource).toEqual({ uid: 'influx1' });
    expect(req.from).toBe(String(window.fromMs));
    expect(req.to).toBe(String(window.toMs));
  });

  it('substitutes other variables and $timeFilter into the live query before sending it', async () => {
    const { client, queryDs } = fakeClient({ queryDsResponse: tagValuesResponse(['h1']) });
    const variable: TemplateVariable = {
      name: 'unreachable_target_hosts',
      type: 'query',
      datasource: influxDs,
      query: 'SHOW TAG VALUES FROM "m" WITH KEY = "target_host" WHERE $timeFilter AND "target_rack" = \'$target_rack\'',
      current: { value: '$__all' },
    };
    const rackVariable: TemplateVariable = { name: 'target_rack', type: 'custom', current: { value: 'AMS201-0210' } };
    await materializeVariables(client, [variable, rackVariable], {}, window);
    const req = queryDs.mock.calls[0]![0] as DsQueryRequest;
    const sentQuery = req.queries[0]!.query as string;
    expect(sentQuery).toContain("'AMS201-0210'");
    expect(sentQuery).toContain(`time >= ${window.fromMs}ms and time <= ${window.toMs}ms`);
  });

  it('marks the variable unresolved when the query is not a "SHOW TAG VALUES" shape', async () => {
    const { client, queryDs } = fakeClient({});
    const variable = allSelectedVariable({ query: 'label_values(up, host)' });
    const result = await materializeVariables(client, [variable], {}, window);
    expect(queryDs).not.toHaveBeenCalled();
    expect(result.unresolvedAllVariables).toEqual(['unreachable_target_hosts']);
  });

  it('marks the variable unresolved when the resolved datasource is not influxdb', async () => {
    const { client, queryDs } = fakeClient({});
    const variable = allSelectedVariable({ datasource: { uid: 'prom1', type: 'prometheus' } });
    const result = await materializeVariables(client, [variable], {}, window);
    expect(queryDs).not.toHaveBeenCalled();
    expect(result.unresolvedAllVariables).toEqual(['unreachable_target_hosts']);
  });

  it('marks the variable unresolved (without throwing) when the live query fails', async () => {
    const { client } = fakeClient({ queryDsError: new Error('network error') });
    const variable = allSelectedVariable();
    const result = await materializeVariables(client, [variable], {}, window);
    expect(result.unresolvedAllVariables).toEqual(['unreachable_target_hosts']);
    expect(result.overrides.unreachable_target_hosts).toBeUndefined();
  });

  it('marks the variable unresolved when the live query returns zero values (fail-open preserved)', async () => {
    const { client } = fakeClient({ queryDsResponse: tagValuesResponse([]) });
    const variable = allSelectedVariable();
    const result = await materializeVariables(client, [variable], {}, window);
    expect(result.unresolvedAllVariables).toEqual(['unreachable_target_hosts']);
  });

  it('applies variable.regex to extract a capture group and drop non-matches', async () => {
    const { client } = fakeClient({ queryDsResponse: tagValuesResponse(['host-h07-lab', 'unrelated', 'host-h08-lab']) });
    const variable = allSelectedVariable({ regex: '/^host-(.+)$/' });
    const result = await materializeVariables(client, [variable], {}, window);
    expect(result.overrides.unreachable_target_hosts).toEqual(['h07-lab', 'h08-lab']);
  });

  it('resolves a datasource given as a "$datasource"-style variable reference', async () => {
    const { client, listDatasources } = fakeClient({
      queryDsResponse: tagValuesResponse(['h1']),
      datasources: [{ uid: 'influx1', name: 'InfluxDB', type: 'influxdb' }],
    });
    const dsVariable: TemplateVariable = { name: 'datasource', type: 'datasource', current: { value: 'InfluxDB' } };
    const variable = allSelectedVariable({ datasource: '$datasource' });
    const result = await materializeVariables(client, [variable, dsVariable], {}, window);
    expect(result.overrides.unreachable_target_hosts).toEqual(['h1']);
    expect(listDatasources).toHaveBeenCalledTimes(1);
  });

  it('fetches the datasource list at most once even with multiple variables needing a lookup', async () => {
    const { client, listDatasources } = fakeClient({
      queryDsResponse: tagValuesResponse(['h1']),
      datasources: [{ uid: 'influx1', name: 'InfluxDB', type: 'influxdb' }],
    });
    const variableA = allSelectedVariable({ name: 'a', datasource: { uid: 'influx1' } });
    const variableB = allSelectedVariable({ name: 'b', datasource: { uid: 'influx1' } });
    await materializeVariables(client, [variableA, variableB], {}, window);
    expect(listDatasources).toHaveBeenCalledTimes(1);
  });
});
