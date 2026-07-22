import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerDiscoverInfluxdbSchema } from '../src/tools/discoverInfluxdbSchema.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { DatasourceInfo, DsQueryRequest, DsQueryResponse } from '../src/grafana/types.js';
import { fakeRegistry, fakeServer } from './toolTestHelpers.js';

const connections: GrafanaConnection[] = [{ id: 'test', name: 'test', url: 'https://grafana.example.com', authType: 'bearer', token: 'x' }];

let dataDir: string;

function config(): Config {
  return {
    connections,
    tlsVerify: true,
    requestTimeoutMs: 1000,
    screenshotTimeoutMs: 45000,
    maxConcurrency: 4,
    maxLookbackHours: 720,
    maxDataPoints: 2000,
    redactionPatterns: [],
    dataDir,
    webhookPort: 4318,
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'discover-influxdb-schema-tool-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function tableResponse(refId: string, values: string[]): DsQueryResponse {
  return { results: { [refId]: { frames: [{ schema: { refId, fields: [{ name: 'name', type: 'string' }] }, data: { values: [values] } }] } } };
}

/** Mirrors Grafana's SHOW TAG VALUES shape: a two-column key/value frame, not a single 'name' column. */
function tagValuesResponse(refId: string, tagKey: string, values: string[]): DsQueryResponse {
  return {
    results: {
      [refId]: {
        frames: [
          {
            schema: { refId, fields: [{ name: 'key', type: 'string' }, { name: 'value', type: 'string' }] },
            data: { values: [values.map(() => tagKey), values] },
          },
        ],
      },
    },
  };
}

function fakeClient(opts: {
  datasources: DatasourceInfo[];
  measurements: string[];
  fieldKeys?: string[];
  tagKeys?: string[];
  tagValues?: string[];
}): GrafanaClient {
  return {
    listDatasources: async () => opts.datasources,
    queryDs: async (req: DsQueryRequest) => {
      const query = req.queries[0]!.query as string;
      if (query.startsWith('SHOW MEASUREMENTS')) return tableResponse('A', opts.measurements);
      if (query.startsWith('SHOW FIELD KEYS')) return tableResponse('A', opts.fieldKeys ?? []);
      if (query.startsWith('SHOW TAG KEYS')) return tableResponse('A', opts.tagKeys ?? []);
      const tagValuesMatch = query.match(/^SHOW TAG VALUES FROM "[^"]*" WITH KEY = "(.*)"$/);
      if (tagValuesMatch) return tagValuesResponse('A', tagValuesMatch[1]!, opts.tagValues ?? []);
      throw new Error(`unexpected query: ${query}`);
    },
  } as unknown as GrafanaClient;
}

const oneInfluxDatasource: DatasourceInfo[] = [{ uid: 'influx1', id: 1, name: 'Griffin-NBS', type: 'influxdb' }];

describe('discover_influxdb_schema tool', () => {
  it('returns only names, no schema, when searchTerm matches more than one measurement', async () => {
    const client = fakeClient({ datasources: oneInfluxDatasource, measurements: ['solidfire_cluster_active_faults', 'solidfire_cluster_capacity'] });
    const { server, call } = fakeServer();
    registerDiscoverInfluxdbSchema(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_influxdb_schema', { connection: 'test', searchTerm: 'solidfire' })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.measurements).toEqual(['solidfire_cluster_active_faults', 'solidfire_cluster_capacity']);
    expect(parsed.measurementsTotal).toBe(2);
    expect(parsed.schema).toBeUndefined();
  });

  it('includes fieldKeys/tagKeys when searchTerm matches exactly one measurement', async () => {
    const client = fakeClient({
      datasources: oneInfluxDatasource,
      measurements: ['solidfire_cluster_active_faults'],
      fieldKeys: ['value'],
      tagKeys: ['cluster', 'region'],
    });
    const { server, call } = fakeServer();
    registerDiscoverInfluxdbSchema(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_influxdb_schema', { connection: 'test', searchTerm: 'active_faults' })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.schema).toEqual({
      measurement: 'solidfire_cluster_active_faults',
      fieldKeys: ['value'],
      tagKeys: ['cluster', 'region'],
    });
  });

  it('enumerates a tag key\'s values into schema.tagValues when tagKey is given for a single measurement', async () => {
    const client = fakeClient({
      datasources: oneInfluxDatasource,
      measurements: ['cpu_load'],
      fieldKeys: ['value'],
      tagKeys: ['host', 'region'],
      tagValues: ['web-03', 'web-01', 'web-02'],
    });
    const { server, call } = fakeServer();
    registerDiscoverInfluxdbSchema(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_influxdb_schema', { connection: 'test', searchTerm: 'cpu_load', tagKey: 'host' })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.schema.tagValues).toEqual({ key: 'host', values: ['web-01', 'web-02', 'web-03'], valuesTotal: 3 });
  });

  it('truncates tagValues to limit but reports the full count in valuesTotal', async () => {
    const client = fakeClient({
      datasources: oneInfluxDatasource,
      measurements: ['cpu_load'],
      tagKeys: ['host'],
      tagValues: ['web-01', 'web-02', 'web-03'],
    });
    const { server, call } = fakeServer();
    registerDiscoverInfluxdbSchema(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_influxdb_schema', { connection: 'test', searchTerm: 'cpu_load', tagKey: 'host', limit: 2 })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.schema.tagValues).toEqual({ key: 'host', values: ['web-01', 'web-02'], valuesTotal: 3 });
  });

  it('errors and lists available tag keys when tagKey is not a tag on the measurement', async () => {
    const client = fakeClient({ datasources: oneInfluxDatasource, measurements: ['cpu_load'], tagKeys: ['host', 'region'] });
    const { server, call } = fakeServer();
    registerDiscoverInfluxdbSchema(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_influxdb_schema', { connection: 'test', searchTerm: 'cpu_load', tagKey: 'nope' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('is not a tag on measurement "cpu_load"');
    expect(result.content[0]!.text).toContain('host, region');
  });

  it('errors when tagKey is given but searchTerm matches more than one measurement', async () => {
    const client = fakeClient({ datasources: oneInfluxDatasource, measurements: ['cpu_load', 'cpu_load_avg'] });
    const { server, call } = fakeServer();
    registerDiscoverInfluxdbSchema(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_influxdb_schema', { connection: 'test', searchTerm: 'cpu_load', tagKey: 'host' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('matched 2 measurement(s)');
  });

  it('errors when no InfluxDB datasource is configured on the connection', async () => {
    const client = fakeClient({ datasources: [{ uid: 'prom1', id: 1, name: 'Prometheus', type: 'prometheus' }], measurements: [] });
    const { server, call } = fakeServer();
    registerDiscoverInfluxdbSchema(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_influxdb_schema', { connection: 'test', searchTerm: 'anything' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('No InfluxDB datasource is configured');
  });

  it('errors and lists candidates when multiple InfluxDB datasources exist and datasourceUid is omitted', async () => {
    const client = fakeClient({
      datasources: [
        { uid: 'influx1', id: 1, name: 'Griffin-NBS', type: 'influxdb' },
        { uid: 'influx2', id: 2, name: 'Griffin-ELB', type: 'influxdb' },
      ],
      measurements: [],
    });
    const { server, call } = fakeServer();
    registerDiscoverInfluxdbSchema(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_influxdb_schema', { connection: 'test', searchTerm: 'anything' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Griffin-NBS');
    expect(result.content[0]!.text).toContain('Griffin-ELB');
  });

  it('errors when an explicit datasourceUid points at a non-InfluxDB datasource', async () => {
    const client = fakeClient({ datasources: [{ uid: 'prom1', id: 1, name: 'Prometheus', type: 'prometheus' }], measurements: [] });
    const { server, call } = fakeServer();
    registerDiscoverInfluxdbSchema(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_influxdb_schema', { connection: 'test', searchTerm: 'anything', datasourceUid: 'prom1' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not influxdb');
  });
});
