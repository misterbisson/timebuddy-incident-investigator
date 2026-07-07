import { describe, expect, it } from 'vitest';
import { filterDatasources } from '../src/tools/listDatasources.js';
import type { DatasourceInfo } from '../src/grafana/types.js';

const datasources: DatasourceInfo[] = [
  { uid: 'prom1', id: 1, name: 'Griffin-Prometheus', type: 'prometheus', isDefault: true },
  { uid: 'influx1', id: 2, name: 'Hermes Global Control Plane', type: 'influxdb' },
  { uid: 'influx2', id: 3, name: 'Griffin-ELB', type: 'influxdb' },
];

describe('filterDatasources', () => {
  it('returns every datasource, summarized, when no query is given', () => {
    expect(filterDatasources(datasources)).toEqual([
      { uid: 'prom1', name: 'Griffin-Prometheus', type: 'prometheus', isDefault: true },
      { uid: 'influx1', name: 'Hermes Global Control Plane', type: 'influxdb', isDefault: undefined },
      { uid: 'influx2', name: 'Griffin-ELB', type: 'influxdb', isDefault: undefined },
    ]);
  });

  it('filters by a case-insensitive substring match against the name', () => {
    const results = filterDatasources(datasources, 'hermes');
    expect(results).toHaveLength(1);
    expect(results[0]?.uid).toBe('influx1');
  });

  it('filters by a case-insensitive substring match against the type', () => {
    const results = filterDatasources(datasources, 'PROM');
    expect(results.map((d) => d.uid)).toEqual(['prom1']);
  });

  it('returns an empty array when nothing matches — e.g. confirming a datasource genuinely no longer exists under any name', () => {
    expect(filterDatasources(datasources, 'nonexistent-datasource')).toEqual([]);
  });
});
