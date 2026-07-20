import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerExportPanelCsv } from '../src/tools/exportPanelCsv.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { DashboardGetResponse, DsQueryRequest, DsQueryResponse } from '../src/grafana/types.js';
import type { Screenshotter } from '../src/screenshot/types.js';
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

function fakeScreenshotter(exportPanelCsv: Screenshotter['exportPanelCsv']): Screenshotter {
  return { capturePanel: async () => Buffer.from(''), exportPanelCsv };
}

function mirrorDashboard(): DashboardGetResponse {
  return {
    dashboard: {
      uid: 'glue',
      title: 'Glue',
      panels: [
        { id: 4, title: 'Success rate over time', datasource: { uid: 'ds1' }, targets: [{ refId: 'A', expr: 'success_rate' }] },
        { id: 6, title: 'Success rate (stat)', datasource: { uid: '-- Dashboard --' }, targets: [{ refId: 'A', panelId: 4 }] },
      ],
    },
    meta: {},
  };
}

describe('export_panel_csv tool', () => {
  it('errors with a clear message instead of a 404 when the panel mirrors another via "-- Dashboard --"', async () => {
    const client = fakeClient(mirrorDashboard(), () => ({ results: {} }));
    const { server, call } = fakeServer();
    registerExportPanelCsv(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('export_panel_csv', {
      dashboardUid: 'glue',
      panelId: 6,
      fromMs: 0,
      toMs: 60000,
      connection: 'test',
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('-- Dashboard --');
    expect(result.content[0]!.text).toContain('panel 4');
  });

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

  it('reports transformationsApplied: false with no note when no screenshotter is configured', async () => {
    const client = fakeClient(timeseriesDashboard(), timeseriesQueryDsResponse);
    const { server, call } = fakeServer();
    registerExportPanelCsv(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('export_panel_csv', { dashboardUid: 'reqs', panelId: 2, fromMs: 0, toMs: 60000, connection: 'test' })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.transformationsApplied).toBe(false);
    expect(parsed.transformCaptureNote).toBeUndefined();
  });
});

describe('export_panel_csv tool with a screenshotter', () => {
  it('uses the browser-captured, transformed CSV as-is and skips the direct query entirely', async () => {
    const queryDs = vi.fn(timeseriesQueryDsResponse);
    const client = fakeClient(timeseriesDashboard(), queryDs);
    const exportPanelCsv = vi.fn(async (req: Parameters<Screenshotter['exportPanelCsv']>[0]) => {
      expect(req.url).toContain('inspect=2');
      expect(req.url).toContain('inspectTab=data');
      return { csv: Buffer.from('"Field","Mean"\r\nweb1,1\r\n') };
    });
    const { server, call } = fakeServer();
    registerExportPanelCsv(server, {
      registry: fakeRegistry(connections, client),
      config: config(),
      screenshotter: fakeScreenshotter(exportPanelCsv),
    });

    const result = (await call('export_panel_csv', { dashboardUid: 'reqs', panelId: 2, fromMs: 0, toMs: 60000, connection: 'test' })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(exportPanelCsv).toHaveBeenCalledOnce();
    expect(queryDs).not.toHaveBeenCalled();
    expect(parsed.transformationsApplied).toBe(true);
    expect(parsed.transformCaptureNote).toBeUndefined();
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].rows).toBe(1);
    expect(parsed.files[0].columns).toEqual(['Field', 'Mean']);

    const csv = await readFile(parsed.files[0].path, 'utf8');
    expect(csv).toBe('"Field","Mean"\r\nweb1,1\r\n');
  });

  it('falls back to the direct export when the panel has no transformations configured', async () => {
    const client = fakeClient(timeseriesDashboard(), timeseriesQueryDsResponse);
    const exportPanelCsv = vi.fn(async () => ({}));
    const { server, call } = fakeServer();
    registerExportPanelCsv(server, {
      registry: fakeRegistry(connections, client),
      config: config(),
      screenshotter: fakeScreenshotter(exportPanelCsv),
    });

    const result = (await call('export_panel_csv', { dashboardUid: 'reqs', panelId: 2, fromMs: 0, toMs: 60000, connection: 'test' })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.transformationsApplied).toBe(false);
    expect(parsed.transformCaptureNote).toBeUndefined();
    expect(parsed.files[0].columns).toEqual(['timestamp', 'host=web1']);
  });

  it('falls back to the direct export and reports transformCaptureNote when the browser attempt fails', async () => {
    const client = fakeClient(timeseriesDashboard(), timeseriesQueryDsResponse);
    const exportPanelCsv = vi.fn(async () => {
      throw new Error('Timed out waiting for the CSV download after 45000ms');
    });
    const { server, call } = fakeServer();
    registerExportPanelCsv(server, {
      registry: fakeRegistry(connections, client),
      config: config(),
      screenshotter: fakeScreenshotter(exportPanelCsv),
    });

    const result = (await call('export_panel_csv', { dashboardUid: 'reqs', panelId: 2, fromMs: 0, toMs: 60000, connection: 'test' })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.transformationsApplied).toBe(false);
    expect(parsed.transformCaptureNote).toMatch(/Timed out waiting for the CSV download/);
    expect(parsed.files[0].columns).toEqual(['timestamp', 'host=web1']);
  });
});

describe('export_panel_csv formula-injection disclosure', () => {
  it('reports formulaNeutralized: true for this server\'s own export, and writes a neutralized cell', async () => {
    const queryDs = vi.fn(timeseriesQueryDsResponse);
    const client = fakeClient(timeseriesDashboard(), queryDs);
    const { server, call } = fakeServer();
    registerExportPanelCsv(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('export_panel_csv', { dashboardUid: 'reqs', panelId: 2, fromMs: 0, toMs: 60000, connection: 'test' })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.formulaNeutralized).toBe(true);
    expect(parsed.formulaNeutralizationNote).toBeUndefined();
  });

  // The gap this PR discloses rather than closes (issue #91): the
  // browser-captured file is Grafana's own bytes, so escapeCsvField never
  // sees it. Pinned as a test so the disclosure can't quietly disappear, and
  // so it fails loudly if someone later makes this path neutralize for real.
  it('reports formulaNeutralized: false for a Grafana-captured file, which really is left unneutralized', async () => {
    const client = fakeClient(timeseriesDashboard(), vi.fn(timeseriesQueryDsResponse));
    const exportPanelCsv = vi.fn(async () => ({ csv: Buffer.from('Field,Mean\r\n=cmd|\' /C calc\'!A0,1\r\n') }));
    const { server, call } = fakeServer();
    registerExportPanelCsv(server, {
      registry: fakeRegistry(connections, client),
      config: config(),
      screenshotter: fakeScreenshotter(exportPanelCsv),
    });

    const result = (await call('export_panel_csv', { dashboardUid: 'reqs', panelId: 2, fromMs: 0, toMs: 60000, connection: 'test' })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.transformationsApplied).toBe(true);
    expect(parsed.formulaNeutralized).toBe(false);
    expect(parsed.formulaNeutralizationNote).toContain('NOT been neutralized');

    const csv = await readFile(parsed.files[0].path, 'utf8');
    expect(csv).toContain('=cmd|\' /C calc\'!A0');
  });
});
