import { describe, expect, it, vi } from 'vitest';
import type { GrafanaConnection } from '../src/config.js';
import type { DashboardGetResponse, DsQueryResponse } from '../src/grafana/types.js';
import type { Screenshotter } from '../src/screenshot/types.js';

// createPanelActions builds its own ConnectionRegistry (unlike the MCP tools,
// which take an injected fake), so mock the GrafanaClient the registry
// instantiates. Its behavior is driven per-test through the hoisted `state`;
// buildAuthHeader and everything else in the module stay real.
const state = vi.hoisted(() => ({
  dashboard: null as unknown,
  queryDs: (() => ({ results: {} })) as (req: unknown) => unknown,
}));

vi.mock('../src/grafana/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/grafana/client.js')>();
  class FakeGrafanaClient {
    async getDashboard() {
      return state.dashboard;
    }
    async queryDs(req: unknown) {
      return state.queryDs(req);
    }
    async listDatasources() {
      return [{ uid: 'ds1', id: 1, name: 'DS', type: 'prometheus' }];
    }
  }
  return { ...actual, GrafanaClient: FakeGrafanaClient };
});

const { createPanelActions } = await import('../src/actions/panelActions.js');

const connections: GrafanaConnection[] = [
  { id: 'test', name: 'Test', url: 'https://grafana.example.com', authType: 'bearer', token: 'x' },
];

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

function noScreenshotter(): Screenshotter {
  return { capturePanel: vi.fn(async () => Buffer.from('')), exportPanelCsv: vi.fn(async () => ({})) };
}

const WINDOW = { fromMs: 0, toMs: 60_000 };

describe('createPanelActions.screenshot', () => {
  it('captures the panel and returns the PNG, a suggested filename, and redacted metadata', async () => {
    state.dashboard = timeseriesDashboard();
    const png = Buffer.from('PNGBYTES');
    const capturePanel = vi.fn(async () => png);
    const actions = createPanelActions(connections, {}, { capturePanel, exportPanelCsv: vi.fn(async () => ({})) });

    const res = await actions.screenshot({ connection: 'test', dashboardUid: 'reqs', panelId: 2, ...WINDOW });

    expect(res.png).toBe(png);
    expect(res.suggestedFilename).toBe('Requests-panel2.png');
    expect(res.meta).toMatchObject({ dashboardUid: 'reqs', panelId: 2, title: 'Requests', type: 'timeseries', width: 1600, height: 900 });
    expect(res.meta.url).toContain('reqs');

    // The capture is driven with the connection's own auth header at the same
    // default size screenshot_panel uses.
    expect(capturePanel).toHaveBeenCalledOnce();
    const arg = capturePanel.mock.calls[0]![0] as Parameters<Screenshotter['capturePanel']>[0];
    expect(arg.headers.Authorization).toBe('Bearer x');
    expect(arg.width).toBe(1600);
    expect(arg.height).toBe(900);
  });
});

describe('createPanelActions.exportCsv', () => {
  it('falls back to the direct export when the panel has no transformations, neutralizing and naming the file', async () => {
    state.dashboard = timeseriesDashboard();
    state.queryDs = timeseriesQueryDsResponse;
    const actions = createPanelActions(connections, {}, noScreenshotter());

    const res = await actions.exportCsv({ connection: 'test', dashboardUid: 'reqs', panelId: 2, ...WINDOW });

    expect(res.files).toHaveLength(1);
    expect(res.files[0]!.suggestedFilename).toBe('Requests-panel2.csv');
    expect(res.files[0]!.columns).toEqual(['timestamp', 'host=web1']);
    expect(res.files[0]!.content).toContain('timestamp,host=web1');
    expect(res.meta).toMatchObject({ transformationsApplied: false, formulaNeutralized: true });
    expect(res.meta.formulaNeutralizationNote).toBeUndefined();
  });

  it('re-serializes and neutralizes the browser-transformed CSV — the whole point of this UI path', async () => {
    state.dashboard = timeseriesDashboard();
    // A formula-leading cell in Grafana's own captured output: unless the UI
    // path neutralizes it (as the MCP tool does), a spreadsheet executes it.
    const exportPanelCsv = vi.fn(async (req: Parameters<Screenshotter['exportPanelCsv']>[0]) => {
      expect(req.url).toContain('inspect=2');
      expect(req.headers.Authorization).toBe('Bearer x');
      return { csv: Buffer.from('Field,Formula\r\nweb1,=1+1\r\n') };
    });
    const actions = createPanelActions(connections, {}, { capturePanel: vi.fn(), exportPanelCsv });

    const res = await actions.exportCsv({ connection: 'test', dashboardUid: 'reqs', panelId: 2, ...WINDOW });

    expect(res.meta.transformationsApplied).toBe(true);
    expect(res.meta.formulaNeutralized).toBe(true);
    expect(String(res.meta.formulaNeutralizationNote)).toContain('semantically identical');
    // The =1+1 cell now leads with an apostrophe; the rest round-trips unchanged.
    expect(res.files[0]!.content).toBe("Field,Formula\r\nweb1,'=1+1\r\n");
    expect(res.files[0]!.columns).toEqual(['Field', 'Formula']);
  });

  it('redacts configured patterns from both the file content and the metadata', async () => {
    state.dashboard = timeseriesDashboard();
    const exportPanelCsv = vi.fn(async () => ({ csv: Buffer.from('Field,Val\r\nSECRET-123,1\r\n') }));
    const actions = createPanelActions(connections, { redactionPatterns: [/SECRET-\d+/g, /Requests/g] }, { capturePanel: vi.fn(), exportPanelCsv });

    const res = await actions.exportCsv({ connection: 'test', dashboardUid: 'reqs', panelId: 2, ...WINDOW });

    expect(res.files[0]!.content).toContain('[REDACTED]');
    expect(res.files[0]!.content).not.toContain('SECRET-123');
    // Same redact() applies to the returned metadata, so a shared status line
    // can't leak a matched identifier either.
    expect(res.meta.title).toBe('[REDACTED]');
  });

  it('derives a filesystem-safe filename from a panel title with path-significant characters', async () => {
    state.dashboard = {
      dashboard: { uid: 'x', title: 'Dash', panels: [{ id: 7, title: 'CPU / Load (avg)', type: 'timeseries', targets: [{ refId: 'A', datasource: { uid: 'ds1' }, expr: 'x' }] }] },
      meta: {},
    };
    state.queryDs = timeseriesQueryDsResponse;
    const actions = createPanelActions(connections, {}, noScreenshotter());

    const res = await actions.exportCsv({ connection: 'test', dashboardUid: 'x', panelId: 7, ...WINDOW });

    expect(res.files[0]!.suggestedFilename).toBe('CPU_Load_avg-panel7.csv');
  });

  it('resolves the panel and window from a round-trippable dashboard/panel URL, as the Activity window passes it', async () => {
    state.dashboard = timeseriesDashboard();
    state.queryDs = timeseriesQueryDsResponse;
    const actions = createPanelActions(connections, {}, noScreenshotter());

    const res = await actions.exportCsv({
      connection: 'test',
      url: 'https://grafana.example.com/d/reqs/requests?viewPanel=2&from=1700000000000&to=1700000600000',
    });

    expect(res.files).toHaveLength(1);
    expect(res.files[0]!.suggestedFilename).toBe('Requests-panel2.csv');
  });

  it('rejects with the underlying error when the panel does not exist', async () => {
    state.dashboard = timeseriesDashboard();
    const actions = createPanelActions(connections, {}, noScreenshotter());

    await expect(actions.exportCsv({ connection: 'test', dashboardUid: 'reqs', panelId: 999, ...WINDOW })).rejects.toThrow(/Panel 999 not found/);
  });
});
