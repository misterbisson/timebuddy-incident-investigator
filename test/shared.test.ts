import { describe, expect, it, vi } from 'vitest';
import { resolveTargetDatasource } from '../src/tools/shared.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { TemplateVariable } from '../src/grafana/types.js';

function fakeClient(datasources: Array<{ uid: string; name: string }>): { client: GrafanaClient; listDatasources: ReturnType<typeof vi.fn> } {
  const listDatasources = vi.fn(async () => datasources.map((d) => ({ ...d, id: 1, type: 'prometheus' })));
  return { client: { listDatasources } as unknown as GrafanaClient, listDatasources };
}

describe('resolveTargetDatasource', () => {
  it('passes through a ref that is not a variable reference without touching the client', async () => {
    const { client, listDatasources } = fakeClient([]);
    const result = await resolveTargetDatasource(client, 'prom1', [], {});
    expect(result).toBe('prom1');
    expect(listDatasources).not.toHaveBeenCalled();
  });

  it('passes through undefined without touching the client', async () => {
    const { client, listDatasources } = fakeClient([]);
    expect(await resolveTargetDatasource(client, undefined, [], {})).toBeUndefined();
    expect(listDatasources).not.toHaveBeenCalled();
  });

  it('resolves a $datasource variable whose current value is already a real UID', async () => {
    const { client } = fakeClient([{ uid: 'prom1', name: 'Prometheus' }]);
    const variables: TemplateVariable[] = [{ name: 'datasource', type: 'datasource', current: { value: 'prom1' } }];
    expect(await resolveTargetDatasource(client, '$datasource', variables, {})).toBe('prom1');
  });

  it('falls back to a name lookup when the variable resolves to a datasource name rather than a UID', async () => {
    const { client } = fakeClient([{ uid: 'prom1', name: 'Griffin-Prometheus' }]);
    const variables: TemplateVariable[] = [{ name: 'DS_PROMETHEUS', type: 'datasource', current: { value: 'Griffin-Prometheus' } }];
    expect(await resolveTargetDatasource(client, '${DS_PROMETHEUS}', variables, {})).toBe('prom1');
  });

  it('returns the unresolved name as-is when no datasource matches it by UID or name', async () => {
    const { client } = fakeClient([{ uid: 'prom1', name: 'Prometheus' }]);
    const variables: TemplateVariable[] = [{ name: 'datasource', type: 'datasource', current: { value: 'gone' } }];
    expect(await resolveTargetDatasource(client, '$datasource', variables, {})).toBe('gone');
  });

  it('returns undefined when the variable itself is not defined on the dashboard', async () => {
    const { client } = fakeClient([{ uid: 'prom1', name: 'Prometheus' }]);
    expect(await resolveTargetDatasource(client, '$missing', [], {})).toBeUndefined();
  });
});
