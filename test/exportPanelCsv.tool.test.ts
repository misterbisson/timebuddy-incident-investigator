import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerExportPanelCsv } from '../src/tools/exportPanelCsv.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { DashboardGetResponse, DsQueryRequest, DsQueryResponse } from '../src/grafana/types.js';
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
  dataDir = await mkdtemp(join(tmpdir(), 'export-panel-csv-tool-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function timeseriesDashboard(): DashboardGetResponse {
  return {
    dashboard: {
      uid: 'reqs',
      title: 'Requests',
      panels: [{ id: 2, title: 'Requests', type: 'timeseries', targets: [{ refId: 'A', datasource: { uid: 'ds1' }, expr: 'http_requests_total' }] }],
    },
    meta: {},
  };
}

function tableDashboard(): DashboardGetResponse {
  return {
    dashboard: {
      uid: 'orders',
      title: 'Orders table',
      panels: [{ id: 1, title: 'Orders', type: 'table', targets: [{ refId: 'A', datasource: { uid: 'ds1' }, expr: 'orders' }] }],
    },
    meta: {},
  };
}

function multiFrameTableDashboard(): DashboardGetResponse {
  return {
    dashboard: {
      uid: 'multi',
      title: 'Multi-query table',
      panels: [
        {
          id: 3,
          title: 'Combined',
          type: 'table',
          targets: [
            { refId: 'A', datasource: { uid: 'ds1' }, expr: 'a' },
            { refId: 'B', datasource: { uid: 'ds1' }, expr: 'b' },
          ],
        },
      ],
    },
    meta: {},
  };
}

function timeseriesQueryDsResponse(): DsQueryResponse {
  return {
    results: {
      A: {
        frames: [
          {
            schema: { refId: 'A', fields: [{ name: 'Time', type: 'time' }, { name: 'value', type: 'number', labels: { host: 'web1' } }] },
            data: { values: [[0, 60000], [1, 2]] },
          },
        ],
      },
    },
  };
}

function tableQueryDsResponse(): DsQueryResponse {
  return {
    results: {
      A: {
        frames: [
          {
            schema: {
              refId: 'A',
              fields: [{ name: 'Time', type: 'time' }, { name: 'host', type: 'string' }, { name: 'value', type: 'number' }],
            },
            data: { values: [[0, 60000], ['web1', 'web2'], [1, 2]] },
          },
        ],
      },
    },
  };
}

function fakeClient(dashboard: DashboardGetResponse, queryDs: (req: DsQueryRequest) => DsQueryResponse): GrafanaClient {
  return {
    getDashboard: async () => dashboard,
    queryDs: async (req: DsQueryRequest) => queryDs(req),
    listDatasources: async () => [{ uid: 'ds1', id: 1, name: 'DS', type: 'prometheus' }],
  } as unknown as GrafanaClient;
}

describe('export_panel_csv tool', () => {
  it('exports a timeseries panel as a wide-format CSV with a UTC timestamp column', async () => {
    const client = fakeClient(timeseriesDashboard(), timeseriesQueryDsResponse);
    const { server, call } = fakeServer();
    registerExportPanelCsv(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('export_panel_csv', {
      dashboardUid: 'reqs',
      panelId: 2,
      fromMs: 0,
      toMs: 60000,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.type).toBe('timeseries');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].rows).toBe(2);
    expect(parsed.files[0].columns).toEqual(['timestamp', 'host=web1']);

    const csv = await readFile(parsed.files[0].path, 'utf8');
    expect(csv).toBe('timestamp,host=web1\r\n1970-01-01T00:00:00.000Z,1\r\n1970-01-01T00:01:00.000Z,2\r\n');
  });

  it('exports a table panel as-is, including its string column', async () => {
    const client = fakeClient(tableDashboard(), tableQueryDsResponse);
    const { server, call } = fakeServer();
    registerExportPanelCsv(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('export_panel_csv', {
      dashboardUid: 'orders',
      panelId: 1,
      fromMs: 0,
      toMs: 60000,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.type).toBe('table');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].columns).toEqual(['Time', 'host', 'value']);
    expect(parsed.files[0].rows).toBe(2);

    const csv = await readFile(parsed.files[0].path, 'utf8');
    expect(csv).toBe('Time,host,value\r\n1970-01-01T00:00:00.000Z,web1,1\r\n1970-01-01T00:01:00.000Z,web2,2\r\n');
  });

  it('writes one file per frame and adds a note when a table panel returns more than one frame', async () => {
    const client = fakeClient(multiFrameTableDashboard(), (req) => ({
      results: Object.fromEntries(
        req.queries.map((q) => [
          q.refId,
          { frames: [{ schema: { refId: q.refId, fields: [{ name: 'value', type: 'number' }] }, data: { values: [[q.refId === 'A' ? 1 : 2]] } }] },
        ]),
      ),
    }));
    const { server, call } = fakeServer();
    registerExportPanelCsv(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('export_panel_csv', {
      dashboardUid: 'multi',
      panelId: 3,
      fromMs: 0,
      toMs: 60000,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.files).toHaveLength(2);
    expect(parsed.files.map((f: { refId: string }) => f.refId).sort()).toEqual(['A', 'B']);
    expect(parsed.note).toBeDefined();
  });

  it('errors when the panel does not exist on the dashboard', async () => {
    const client = fakeClient(timeseriesDashboard(), timeseriesQueryDsResponse);
    const { server, call } = fakeServer();
    registerExportPanelCsv(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('export_panel_csv', {
      dashboardUid: 'reqs',
      panelId: 999,
      fromMs: 0,
      toMs: 60000,
      connection: 'test',
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not found/);
  });

  it('errors when neither url nor dashboardUid is provided', async () => {
    const client = fakeClient(timeseriesDashboard(), timeseriesQueryDsResponse);
    const { server, call } = fakeServer();
    registerExportPanelCsv(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('export_panel_csv', { fromMs: 0, toMs: 60000, connection: 'test' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Must provide either "url"/);
  });
});
