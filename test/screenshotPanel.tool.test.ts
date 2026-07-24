import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerScreenshotPanel } from '../src/tools/screenshotPanel.js';
import { MAX_SCREENSHOT_AREA_PX, MAX_SCREENSHOT_PX, MIN_SCREENSHOT_PX } from '../src/security/limits.js';
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
    // Echo the requested size back as the "observed" size, so existing
    // assertions that the result reports the clamped dimensions still hold; a
    // dedicated test overrides this to prove the result echoes observed, not requested.
    return { png: Buffer.from('fake-png'), width: req.width, height: req.height };
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
  // One absurd axis with a modest other axis is bounded by the per-axis cap
  // (their product is well under the area cap, so no further scaling).
  it('clamps an absurd single dimension to the per-axis cap before it reaches capturePanel', async () => {
    const { call, captured } = harness();
    await call('screenshot_panel', { ...baseArgs, width: 100_000, height: 900 });
    expect(captured[0]!.width).toBe(MAX_SCREENSHOT_PX);
    expect(captured[0]!.height).toBe(900);
  });

  // Both axes absurd: per-axis clamping alone would still permit an 8192×8192 ≈
  // 67 Mpx buffer, so the area cap scales both down (keeping aspect ratio) to
  // bound the actual allocation. This is issue #96 part 1.
  it('scales both axes down to the area cap when their product is still too large', async () => {
    const { call, captured } = harness();
    await call('screenshot_panel', { ...baseArgs, width: 100_000, height: 100_000 });
    expect(captured[0]!.width).toBeLessThanOrEqual(MAX_SCREENSHOT_PX);
    expect(captured[0]!.width * captured[0]!.height).toBeLessThanOrEqual(MAX_SCREENSHOT_AREA_PX);
    // A square request stays square after area-scaling.
    expect(captured[0]!.width).toBe(captured[0]!.height);
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

  // Issue #96 part 2: the result echoes the size the capture actually came back
  // at (observed from the image), not the size it was asked for. Proven by a
  // screenshotter that reports a size unrelated to the request.
  it('reports the observed capture size, not the requested one', async () => {
    const captured: CapturePanelRequest[] = [];
    const capturePanel = vi.fn(async (req: CapturePanelRequest) => {
      captured.push(req);
      return { png: Buffer.from('fake-png'), width: 1234, height: 567 };
    });
    const screenshotter = { capturePanel, exportPanelCsv: vi.fn() } as unknown as Screenshotter;
    const client = { getDashboard: vi.fn(async () => dashboard()) } as unknown as GrafanaClient;
    const { server, call } = fakeServer();
    registerScreenshotPanel(server, { registry: fakeRegistry(connections, client), config: config(), screenshotter } as never);

    const result = payload(await call('screenshot_panel', { ...baseArgs, width: 1600, height: 900, connection: 'test' }));
    expect(captured[0]).toMatchObject({ width: 1600, height: 900 });
    expect(result.width).toBe(1234);
    expect(result.height).toBe(567);
  });

  it('warns when the area cap scaled the capture down', async () => {
    const { call } = harness();
    const result = payload(await call('screenshot_panel', { ...baseArgs, width: 8000, height: 8000 }));
    const warnings = (result.warnings as string[]) ?? [];
    expect(warnings.some((w) => /Mpx cap/.test(w))).toBe(true);
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
    const screenshotter = {
      capturePanel: vi.fn(async (req: CapturePanelRequest) => ({ png, width: req.width, height: req.height })),
      exportPanelCsv: vi.fn(),
    } as unknown as Screenshotter;
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

// Issue #96 part 3: each capture allocates a BrowserWindow + PNG buffer in this
// process, and maxConcurrency previously gated only Grafana HTTP calls, not
// captures. The gate is keyed by maxConcurrency, so a value no other test uses
// gives this one its own isolated gate.
describe('screenshot_panel capture concurrency', () => {
  it('never runs more concurrent captures than maxConcurrency', async () => {
    const MAX_CONC = 3; // unique across this file, so this test gets its own gate
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => {
      release = r;
    });
    const capturePanel = vi.fn(async (req: CapturePanelRequest) => {
      active++;
      peak = Math.max(peak, active);
      await gateOpen; // hold every capture open until we've launched them all
      active--;
      return { png: Buffer.from('p'), width: req.width, height: req.height };
    });
    const screenshotter = { capturePanel, exportPanelCsv: vi.fn() } as unknown as Screenshotter;
    const client = { getDashboard: vi.fn(async () => dashboard()) } as unknown as GrafanaClient;
    const { server, call } = fakeServer();
    const cfg = { ...config(), maxConcurrency: MAX_CONC };
    registerScreenshotPanel(server, { registry: fakeRegistry(connections, client), config: cfg, screenshotter } as never);

    const calls = Array.from({ length: 6 }, () => call('screenshot_panel', { ...baseArgs, connection: 'test' }));
    // Let the gate fill up, then release everything.
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all(calls);

    expect(peak).toBe(MAX_CONC); // filled the gate but never exceeded it
    expect(capturePanel).toHaveBeenCalledTimes(6);
  });
});
