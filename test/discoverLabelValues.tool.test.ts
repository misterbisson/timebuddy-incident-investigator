import { describe, expect, it, vi } from 'vitest';
import { registerDiscoverLabelValues } from '../src/tools/discoverLabelValues.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { DatasourceInfo, DsQueryRequest, DsQueryResponse } from '../src/grafana/types.js';
import { fakeRegistry, fakeServer } from './toolTestHelpers.js';

const connections: GrafanaConnection[] = [{ id: 'test', name: 'test', url: 'https://grafana.example.com', authType: 'bearer', token: 'x' }];

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
    dataDir: '.data',
    webhookPort: 4318,
  };
}

/** Grafana's SHOW TAG VALUES shape: a two-column key/value frame. */
function tagValuesResponse(tagKey: string, values: string[]): DsQueryResponse {
  return {
    results: {
      A: {
        frames: [
          {
            schema: { refId: 'A', fields: [{ name: 'key', type: 'string' }, { name: 'value', type: 'string' }] },
            data: { values: [values.map(() => tagKey), values] },
          },
        ],
      },
    },
  };
}

function fakeClient(opts: {
  datasources: DatasourceInfo[];
  influxError?: string;
  influxValues?: string[];
  promValues?: string[];
  lokiValues?: string[];
}): {
  client: GrafanaClient;
  queryDs: ReturnType<typeof vi.fn>;
  getPrometheusLabelValues: ReturnType<typeof vi.fn>;
  getLokiLabelValues: ReturnType<typeof vi.fn>;
} {
  const queryDs = vi.fn(async (_req: DsQueryRequest) =>
    opts.influxError ? ({ results: { A: { error: opts.influxError } } } as DsQueryResponse) : tagValuesResponse('host', opts.influxValues ?? []),
  );
  const getPrometheusLabelValues = vi.fn(async () => opts.promValues ?? []);
  const getLokiLabelValues = vi.fn(async () => opts.lokiValues ?? []);
  const client = {
    listDatasources: async () => opts.datasources,
    queryDs,
    getPrometheusLabelValues,
    getLokiLabelValues,
  } as unknown as GrafanaClient;
  return { client, queryDs, getPrometheusLabelValues, getLokiLabelValues };
}

describe('discover_label_values tool', () => {
  it('dispatches to Prometheus label_values, passing metric as the match scope', async () => {
    const { client, getPrometheusLabelValues } = fakeClient({
      datasources: [{ uid: 'prom1', id: 1, name: 'Prometheus', type: 'prometheus' }],
      promValues: ['web-03', 'web-01', 'web-02'],
    });
    const { server, call } = fakeServer();
    registerDiscoverLabelValues(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_label_values', { connection: 'test', metric: 'up', label: 'instance' })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(getPrometheusLabelValues).toHaveBeenCalledWith('prom1', 'instance', 'up');
    expect(parsed.datasourceType).toBe('prometheus');
    expect(parsed.values).toEqual(['web-01', 'web-02', 'web-03']);
    expect(parsed.valuesTotal).toBe(3);
  });

  it('dispatches to InfluxDB SHOW TAG VALUES', async () => {
    const { client, queryDs, getPrometheusLabelValues } = fakeClient({
      datasources: [{ uid: 'influx1', id: 1, name: 'InfluxDB', type: 'influxdb' }],
      influxValues: ['h2', 'h1'],
    });
    const { server, call } = fakeServer();
    registerDiscoverLabelValues(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_label_values', { connection: 'test', metric: 'cpu_load', label: 'host' })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(getPrometheusLabelValues).not.toHaveBeenCalled();
    expect((queryDs.mock.calls[0]![0] as DsQueryRequest).queries[0]!.query).toBe('SHOW TAG VALUES FROM "cpu_load" WITH KEY = "host"');
    expect(parsed.datasourceType).toBe('influxdb');
    expect(parsed.values).toEqual(['h1', 'h2']);
  });

  it('dispatches to Loki label values', async () => {
    const { client, getLokiLabelValues } = fakeClient({
      datasources: [{ uid: 'loki1', id: 1, name: 'Loki', type: 'loki' }],
      lokiValues: ['api', 'worker'],
    });
    const { server, call } = fakeServer();
    registerDiscoverLabelValues(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_label_values', { connection: 'test', metric: '{job="app"}', label: 'pod' })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(getLokiLabelValues).toHaveBeenCalledWith('loki1', 'pod', '{job="app"}');
    expect(parsed.datasourceType).toBe('loki');
    expect(parsed.values).toEqual(['api', 'worker']);
  });

  it('dedupes and truncates to limit while reporting the full count in valuesTotal', async () => {
    const { client } = fakeClient({
      datasources: [{ uid: 'prom1', id: 1, name: 'Prometheus', type: 'prometheus' }],
      promValues: ['a', 'b', 'b', 'c'],
    });
    const { server, call } = fakeServer();
    registerDiscoverLabelValues(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_label_values', { connection: 'test', metric: 'up', label: 'instance', limit: 2 })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.values).toEqual(['a', 'b']);
    expect(parsed.valuesTotal).toBe(3);
  });

  it('surfaces a datasource-level query failure as a hard error, not an empty list', async () => {
    const { client } = fakeClient({
      datasources: [{ uid: 'influx1', id: 1, name: 'InfluxDB', type: 'influxdb' }],
      influxError: 'measurement not found',
    });
    const { server, call } = fakeServer();
    registerDiscoverLabelValues(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_label_values', { connection: 'test', metric: 'nope', label: 'host' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('SHOW TAG VALUES failed: measurement not found');
  });

  it('errors when an explicit datasourceUid points at an unsupported datasource type', async () => {
    const { client } = fakeClient({ datasources: [{ uid: 'es1', id: 1, name: 'Elastic', type: 'elasticsearch' }] });
    const { server, call } = fakeServer();
    registerDiscoverLabelValues(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_label_values', { connection: 'test', metric: 'x', label: 'y', datasourceUid: 'es1' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("type \"elasticsearch\"");
  });

  it('errors when no label-capable datasource is configured', async () => {
    const { client } = fakeClient({ datasources: [{ uid: 'es1', id: 1, name: 'Elastic', type: 'elasticsearch' }] });
    const { server, call } = fakeServer();
    registerDiscoverLabelValues(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_label_values', { connection: 'test', metric: 'x', label: 'y' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('No InfluxDB, Prometheus, or Loki datasource');
  });

  it('errors and lists candidates when multiple label-capable datasources exist and datasourceUid is omitted', async () => {
    const { client } = fakeClient({
      datasources: [
        { uid: 'influx1', id: 1, name: 'InfluxDB', type: 'influxdb' },
        { uid: 'prom1', id: 2, name: 'Prometheus', type: 'prometheus' },
      ],
    });
    const { server, call } = fakeServer();
    registerDiscoverLabelValues(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('discover_label_values', { connection: 'test', metric: 'x', label: 'y' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('InfluxDB (influx1, influxdb)');
    expect(result.content[0]!.text).toContain('Prometheus (prom1, prometheus)');
  });
});
