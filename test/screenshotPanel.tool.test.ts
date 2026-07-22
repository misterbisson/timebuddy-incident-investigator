import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerScreenshotPanel } from '../src/tools/screenshotPanel.js';
import { MAX_SCREENSHOT_PX, MIN_SCREENSHOT_PX } from '../src/security/limits.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { CapturePanelRequest, Screenshotter } from '../src/screenshot/types.js';
import type { DashboardGetResponse } from '../src/grafana/types.js';
import type { ActivityEntryInput, ActivityLog } from '../src/activity/activityLog.js';
import { fakeRegistry, fakeServer } from './toolTestHelpers.js';

const connections: GrafanaConnection[] = [
  { id: 'test', name: 'test', url: 'https://grafana.example.com', authType: 'bearer', token: 'x' },
];

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
  dataDir = await mkdtemp(join(tmpdir(), 'screenshot-panel-tool-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function dashboard(): DashboardGetResponse {
  return {
    dashboard: {
      uid: 'reqs',
      title: 'Requests',
      panels: [{ id: 2, title: 'Requests', type: 'timeseries', targets: [{ refId: 'A', datasource: { uid: 'ds1' }, expr: 'up' }] }],
    },
    meta: {},
  };
}

/** Records what capturePanel was actually asked for — the value that would reach BrowserWindow. */
function harness() {
  const captured: CapturePanelRequest[] = [];
  const capturePanel = vi.fn(async (req: CapturePanelRequest) => {
    captured.push(req);
    return Buffer.from('fake-png');
  });
  const screenshotter = { capturePanel, exportPanelCsv: vi.fn() } as unknown as Screenshotter;
  const client = { getDashboard: vi.fn(async () => dashboard()) } as unknown as GrafanaClient;
  const { server, call } = fakeServer();
  registerScreenshotPanel(server, {
    registry: fakeRegistry(connections, client),
    config: config(),
    screenshotter,
    activityLog: undefined,
  } as never);
  return { call, captured };
}

const baseArgs = { dashboardUid: 'reqs', panelId: 2, fromMs: 1_000_000, toMs: 2_000_000 };

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return JSON.parse(content.find((c) => c.type === 'text')!.text!);
}

describe('screenshot_panel dimension clamping', () => {
  it('passes through dimensions that are already within bounds, with no warning', async () => {
    const { call, captured } = harness();
    const result = await call('screenshot_panel', { ...baseArgs, width: 1600, height: 900 });
    expect(captured[0]).toMatchObject({ width: 1600, height: 900 });
    expect(payload(result)).toMatchObject({ width: 1600, height: 900 });
    expect(payload(result).warnings).toBeUndefined();
  });

  // The reported crash: an unbounded dimension reaches BrowserWindow, which
  // allocates a pixel buffer of that size inside the MCP server's own process.
  it('clamps an absurd dimension before it can reach capturePanel', async () => {
    const { call, captured } = harness();
    await call('screenshot_panel', { ...baseArgs, width: 100_000, height: 100_000 });
    expect(captured[0]!.width).toBe(MAX_SCREENSHOT_PX);
    expect(captured[0]!.height).toBe(MAX_SCREENSHOT_PX);
  });

  it('clamps a zero or negative dimension up to the floor, rather than letting Electron reject it', async () => {
    const { call, captured } = harness();
    await call('screenshot_panel', { ...baseArgs, width: 0, height: -50 });
    expect(captured[0]).toMatchObject({ width: MIN_SCREENSHOT_PX, height: MIN_SCREENSHOT_PX });
  });

  it('rounds a fractional dimension to an integer, since BrowserWindow takes whole pixels', async () => {
    const { call, captured } = harness();
    await call('screenshot_panel', { ...baseArgs, width: 1600.5, height: 900.4 });
    expect(captured[0]).toMatchObject({ width: 1601, height: 900 });
  });

  // Per the runsTotal/pointsTotal precedent: a result silently returned at
  // dimensions other than the ones requested reads as complete but isn't.
  it('reports the clamp in warnings and echoes the dimensions actually captured', async () => {
    const { call } = harness();
    const result = payload(await call('screenshot_panel', { ...baseArgs, width: 100_000, height: 900 }));
    expect(result.width).toBe(MAX_SCREENSHOT_PX);
    expect(result.height).toBe(900);
    expect(result.warnings).toHaveLength(1);
    expect((result.warnings as string[])[0]).toContain(String(MAX_SCREENSHOT_PX));
  });

  // Guards the fallback direction. An earlier draft treated any non-finite
  // input as "clamp to the maximum", which turned a *missing* dimension into
  // the largest allowed one — the opposite of safe, and invisible in
  // production only because zod's .default() fills it in first.
  it('falls back to the default size, not the maximum, when a dimension is missing or non-finite', async () => {
    const { call, captured } = harness();
    const result = await call('screenshot_panel', baseArgs);
    expect(captured[0]).toMatchObject({ width: 1600, height: 900 });
    // A fallback is not a clamp. This previously warned "Requested
    // undefinedxundefined was clamped to 1600x900" on the plain defaults path.
    expect(payload(result).warnings).toBeUndefined();

    const nonFinite = await call('screenshot_panel', { ...baseArgs, width: Number.POSITIVE_INFINITY, height: Number.NaN });
    expect(captured[1]).toMatchObject({ width: 1600, height: 900 });
    expect(payload(nonFinite).warnings).toBeUndefined();
  });
});

describe('screenshot_panel result, persistence, and errors', () => {
  function recordingActivityLog(): { activityLog: ActivityLog; recorded: ActivityEntryInput[] } {
    const recorded: ActivityEntryInput[] = [];
    return { activityLog: { record: (e) => recorded.push(e) }, recorded };
  }

  function setup(activityLog?: ActivityLog) {
    const png = Buffer.from('fake-png');
    const client = { getDashboard: vi.fn(async () => dashboard()) } as unknown as GrafanaClient;
    const screenshotter = { capturePanel: vi.fn(async () => png), exportPanelCsv: vi.fn() } as unknown as Screenshotter;
    const { server, call } = fakeServer();
    registerScreenshotPanel(server, { registry: fakeRegistry(connections, client), config: config(), screenshotter, activityLog } as never);
    return { call, png };
  }

  it('returns the PNG inline, echoes panel identity, and writes the image to disk', async () => {
    const { call, png } = setup();
    const result = (await call('screenshot_panel', { ...baseArgs, connection: 'test' })) as {
      content: Array<{ type: string; data?: string; text?: string }>;
    };

    const image = result.content.find((c) => c.type === 'image');
    expect(image?.data).toBe(png.toString('base64'));
    const parsed = payload(result);
    expect(parsed).toMatchObject({ dashboardUid: 'reqs', panelId: 2, title: 'Requests', type: 'timeseries' });
    expect(parsed.url).toContain('grafana.example.com');
    expect(await readFile(parsed.savedTo as string)).toEqual(png);
  });

  it('records an activity entry carrying the saved screenshot path', async () => {
    const { activityLog, recorded } = recordingActivityLog();
    const { call } = setup(activityLog);

    await call('screenshot_panel', { ...baseArgs, connection: 'test' });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ toolName: 'screenshot_panel', dashboardUid: 'reqs', panelId: 2 });
    expect(recorded[0]!.screenshotPath).toMatch(/\.png$/);
  });

  it('returns an error result with a dashboard link when the panel is not found', async () => {
    const { call } = setup();
    const result = (await call('screenshot_panel', { ...baseArgs, panelId: 999, connection: 'test' })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = result.content.find((c) => c.type === 'text')!.text!;
    expect(text).toContain('Panel 999 not found');
    expect(text).toContain('grafana.example.com');
  });

  // The dashboard is known by the time panelId is found missing, so the error
  // still carries a clickable dashboard link — the resolve prologue must report
  // the resolved dashboardUid before, not after, the panelId check.
  it('still attaches the dashboard link when only panelId is missing', async () => {
    const { call } = setup();
    const result = (await call('screenshot_panel', { dashboardUid: 'reqs', fromMs: 1_000_000, toMs: 2_000_000, connection: 'test' })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = result.content.find((c) => c.type === 'text')!.text!;
    expect(text).toContain('panelId');
    expect(text).toContain('grafana.example.com');
  });
});
