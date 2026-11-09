import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRenderDashboard } from '../src/tools/renderDashboard.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { DashboardGetResponse } from '../src/grafana/types.js';
import { fakeGrafanaClient, fakeRegistry, fakeServer, numberSeriesResponse } from './toolTestHelpers.js';

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

function dashboardWithAllVariable(): DashboardGetResponse {
  return {
    dashboard: {
      uid: 'dash1',
      title: 'Host connectivity',
      version: 1,
      time: { from: 'now-1h', to: 'now' },
      templating: {
        list: [
          {
            name: 'unreachable_target_hosts',
            type: 'query',
            datasource: { uid: 'influx1', type: 'influxdb' },
            query: 'SHOW TAG VALUES FROM "m" WITH KEY = "target_host" WHERE $timeFilter',
            current: { value: '$__all' },
          },
        ],
      },
      panels: [
        {
          id: 1,
          title: 'Unreachable target hosts',
          targets: [
            { refId: 'A', datasource: { uid: 'influx1' }, query: 'SELECT mean("v") FROM "m" WHERE "target_host" =~ /$unreachable_target_hosts/', rawQuery: true },
          ],
        },
      ],
    },
    meta: {},
  };
}

describe('render_dashboard tool', () => {
  it('live-resolves a "$__all" variable for the actual query, but keeps dashboard/panel URLs built from the original (un-expanded) override', async () => {
    const { client } = fakeGrafanaClient({ dashboard: dashboardWithAllVariable(), liveValues: ['h1', 'h2', 'h3'] });
    const { server, call } = fakeServer();
    registerRenderDashboard(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('render_dashboard', {
      dashboardUid: 'dash1',
      fromMs: 1_700_000_000_000,
      toMs: 1_700_003_600_000,
      variableOverrides: { unreachable_target_hosts: ['$__all'] },
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.unresolvedAllVariables).toBeUndefined();
    const panel = parsed.panels.find((p: { panelId: number }) => p.panelId === 1);
    expect(panel.targets[0].resolvedQuery.query).toContain('(h1|h2|h3)');
    // The clickable URL must reflect what a human actually selected ($__all), not the
    // internally-expanded three-host list — an exploded var-* query param would be an
    // unusable (and potentially enormous) link.
    expect(panel.url).toBe(
      'https://grafana.example.com/d/dash1?viewPanel=1&from=1700000000000&to=1700003600000&var-unreachable_target_hosts=%24__all',
    );
  });

  it('lists the variable in unresolvedAllVariables when live resolution finds nothing', async () => {
    const { client } = fakeGrafanaClient({ dashboard: dashboardWithAllVariable(), liveValues: [] });
    const { server, call } = fakeServer();
    registerRenderDashboard(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('render_dashboard', {
      dashboardUid: 'dash1',
      fromMs: 1_700_000_000_000,
      toMs: 1_700_003_600_000,
      variableOverrides: { unreachable_target_hosts: ['$__all'] },
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.unresolvedAllVariables).toEqual(['unreachable_target_hosts']);
  });

  it('does not silently drop a panel when two panels share the same panelId', async () => {
    const dashboard: DashboardGetResponse = {
      dashboard: {
        uid: 'dash2',
        title: 'Duplicate ids',
        version: 1,
        time: { from: 'now-1h', to: 'now' },
        panels: [
          { id: 9, title: 'Compute', targets: [{ refId: 'A', datasource: { uid: 'prom1' }, expr: 'up{product="compute"}' }] },
          { id: 9, title: 'Block Storage', targets: [{ refId: 'A', datasource: { uid: 'prom1' }, expr: 'up{product="block-storage"}' }] },
          { id: 10, title: 'Row header (non-queryable)', type: 'row' },
        ],
      },
      meta: {},
    };
    const { client } = fakeGrafanaClient({ dashboard });
    const { server, call } = fakeServer();
    registerRenderDashboard(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('render_dashboard', {
      dashboardUid: 'dash2',
      fromMs: 1_700_000_000_000,
      toMs: 1_700_003_600_000,
      // fakeServer's call() bypasses zod (unlike the real MCP server), so the
      // schema's panelLimit default isn't applied here - pass it explicitly.
      panelLimit: 25,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.panelsTotal).toBe(2);
    const titles = parsed.panels.map((p: { title?: string }) => p.title);
    expect(titles).toContain('Compute');
    expect(titles).toContain('Block Storage');
    expect(titles).toContain('Row header (non-queryable)');
    expect(parsed.panels).toHaveLength(3);
  });

  it('marks a duplicate-panelId panel beyond panelLimit as skipped rather than dropping it', async () => {
    const dashboard: DashboardGetResponse = {
      dashboard: {
        uid: 'dash2',
        title: 'Duplicate ids',
        version: 1,
        time: { from: 'now-1h', to: 'now' },
        panels: [
          { id: 9, title: 'Compute', targets: [{ refId: 'A', datasource: { uid: 'prom1' }, expr: 'up{product="compute"}' }] },
          { id: 9, title: 'Block Storage', targets: [{ refId: 'A', datasource: { uid: 'prom1' }, expr: 'up{product="block-storage"}' }] },
        ],
      },
      meta: {},
    };
    const { client } = fakeGrafanaClient({ dashboard });
    const { server, call } = fakeServer();
    registerRenderDashboard(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('render_dashboard', {
      dashboardUid: 'dash2',
      fromMs: 1_700_000_000_000,
      toMs: 1_700_003_600_000,
      panelLimit: 1,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.panelsExecuted).toBe(1);
    expect(parsed.panelsSkipped).toBe(1);
    const skipped = parsed.panels.find((p: { skipped?: boolean }) => p.skipped);
    expect(skipped.title).toBe('Block Storage');
  });

  it('reports a mirror panel ("-- Dashboard --" datasource) with mirrorsPanelIds instead of a 404', async () => {
    const dashboard: DashboardGetResponse = {
      dashboard: {
        uid: 'dash3',
        title: 'Glue',
        version: 1,
        time: { from: 'now-1h', to: 'now' },
        panels: [
          { id: 4, title: 'Success rate over time', datasource: { uid: 'influx1' }, targets: [{ refId: 'A', query: 'SELECT mean("success")' }] },
          { id: 6, title: 'Success rate (stat)', datasource: { uid: '-- Dashboard --' }, targets: [{ refId: 'A', panelId: 4 }] },
        ],
      },
      meta: {},
    };
    const { client } = fakeGrafanaClient({ dashboard });
    const { server, call } = fakeServer();
    registerRenderDashboard(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('render_dashboard', {
      dashboardUid: 'dash3',
      fromMs: 1_700_000_000_000,
      toMs: 1_700_003_600_000,
      panelLimit: 25,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    const mirror = parsed.panels.find((p: { panelId: number }) => p.panelId === 6);
    expect(mirror.mirrorsPanelIds).toEqual([4]);
    expect(mirror.executionError).toBeUndefined();
    expect(mirror.errors).toBeUndefined();
    // Doesn't occupy an execution slot or count toward panelsSkipped.
    expect(parsed.panelsExecuted).toBe(1);
    expect(parsed.panelsSkipped).toBe(0);
  });

  it('omits raw points but keeps stats when includePoints is false', async () => {
    const { client } = fakeGrafanaClient({ dashboard: dashboardWithAllVariable(), liveValues: ['h1', 'h2'] });
    const { server, call } = fakeServer();
    registerRenderDashboard(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('render_dashboard', {
      dashboardUid: 'dash1',
      fromMs: 1_700_000_000_000,
      toMs: 1_700_003_600_000,
      panelLimit: 25,
      includePoints: false,
      connection: 'test',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);

    const panel = parsed.panels.find((p: { panelId: number }) => p.panelId === 1);
    expect(panel.series[0].points).toBeUndefined();
    expect(panel.series[0].stats).toBeDefined();
  });
});

describe('render_dashboard relative-time resolution', () => {
  function plainDashboard(): DashboardGetResponse {
    return {
      dashboard: {
        uid: 'dash2',
        title: 'Requests',
        timezone: 'America/Los_Angeles',
        weekStart: 'monday',
        time: { from: 'now-6h', to: 'now' },
        panels: [{ id: 1, title: 'Requests', targets: [{ refId: 'A', datasource: { uid: 'influx1' }, query: 'SELECT 1', rawQuery: true }] }],
      },
      meta: {},
    };
  }

  async function render(args: Record<string, unknown>) {
    const { client } = fakeGrafanaClient({ dashboard: plainDashboard() });
    const { server, call } = fakeServer();
    registerRenderDashboard(server, { registry: fakeRegistry(connections, client), config: config() });
    const result = (await call('render_dashboard', args)) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0]!.text) as { window: Record<string, unknown> };
  }

  // `now/w` resolves against the real clock, so every case here pins it: an
  // unpinned week-length assertion fails in exactly the weeks that contain a
  // DST transition, which is how this test once blocked CI from Oct 26 to Nov 1.
  // Only Date is faked; the tool's own async work runs on real timers.
  afterEach(() => {
    vi.useRealTimers();
  });

  function pinClock(iso: string) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(iso));
  }

  async function renderThisWeek() {
    return render({ url: 'https://grafana.example.com/d/dash2?from=now%2Fw&to=now%2Fw' });
  }

  it("resolves a link's rounding shorthand against the dashboard's own zone and week-start", async () => {
    pinClock('2026-07-08T19:00:00Z'); // Wednesday noon, PDT all week
    const { window } = await renderThisWeek();
    expect(window.relativeTime).toEqual({
      from: 'now/w',
      to: 'now/w',
      timeZone: 'America/Los_Angeles',
      timeZoneSource: 'dashboard',
      weekStart: 'monday',
      weekStartSource: 'dashboard',
    });
    // A Monday-start week in Los Angeles, from its first millisecond to its last.
    expect(window.fromMs).toBe(Date.parse('2026-07-06T07:00:00.000Z')); // Mon 00:00 PDT
    expect(window.toMs).toBe(Date.parse('2026-07-13T06:59:59.999Z')); // Sun 23:59:59.999 PDT
    expect((window.toMs as number) - (window.fromMs as number)).toBe(7 * 86_400_000 - 1);
  });

  // The window follows the wall-clock week, not a fixed 7 x 24h: a week holding
  // a DST transition is an hour longer or shorter, and Grafana's own window is too.
  it('spans the wall-clock week, an hour longer, across a fall-back transition', async () => {
    pinClock('2026-10-28T19:00:00Z'); // Wednesday noon; LA falls back Sun Nov 1
    const { window } = await renderThisWeek();
    expect(window.fromMs).toBe(Date.parse('2026-10-26T07:00:00.000Z')); // Mon 00:00 PDT
    expect(window.toMs).toBe(Date.parse('2026-11-02T07:59:59.999Z')); // Sun 23:59:59.999 PST
    expect((window.toMs as number) - (window.fromMs as number)).toBe(7 * 86_400_000 + 3_600_000 - 1);
  });

  it('spans the wall-clock week, an hour shorter, across a spring-forward transition', async () => {
    pinClock('2027-03-10T20:00:00Z'); // Wednesday noon; LA springs forward Sun Mar 14
    const { window } = await renderThisWeek();
    expect(window.fromMs).toBe(Date.parse('2027-03-08T08:00:00.000Z')); // Mon 00:00 PST
    expect(window.toMs).toBe(Date.parse('2027-03-15T06:59:59.999Z')); // Sun 23:59:59.999 PDT
    expect((window.toMs as number) - (window.fromMs as number)).toBe(7 * 86_400_000 - 3_600_000 - 1);
  });

  it("resolves the dashboard's own saved default range when the call carries no window at all", async () => {
    const { window } = await render({ dashboardUid: 'dash2', connection: 'test' });
    // A fixed-duration shift is the same instant in every zone, so the
    // dashboard's zone isn't reported here — it didn't bear on the result.
    expect(window.relativeTime).toEqual({ from: 'now-6h', to: 'now' });
    expect((window.toMs as number) - (window.fromMs as number)).toBe(6 * 3_600_000);
  });

  it('reports a plain window with no resolution metadata when both bounds were passed as epoch ms', async () => {
    const { window } = await render({ dashboardUid: 'dash2', connection: 'test', fromMs: 1_000, toMs: 2_000 });
    expect(window).toEqual({ fromMs: 1_000, toMs: 2_000 });
  });

  // Issue #297: render_dashboard replayed this panel at a 5s $__interval over
  // 1-minute data, and fill(0) scored the empty buckets as 0 (a healthy 1.0
  // read as ~0.08). #299 fixed the step; this pins it here and requires the
  // step to be reported, so a wrong one shows in the result.
  describe('replay step (issue #297)', () => {
    const FROM = 1_791_146_314_032;
    const TO = FROM + 50 * 60_000;

    function influxPanel(id: number, title: string, interval: string) {
      return {
        id,
        title,
        interval,
        targets: [
          {
            refId: 'A',
            datasource: { uid: 'influx1', type: 'influxdb' },
            rawQuery: true,
            query: 'SELECT MEAN("score") FROM "m" WHERE $timeFilter GROUP BY time($__interval) fill(0)',
          },
        ],
      };
    }

    async function render(panels: unknown[], gapMs: number) {
      const dashboard = { dashboard: { uid: 'd297', title: 'Status', version: 1, panels }, meta: {} } as unknown as DashboardGetResponse;
      const { client, queryDs } = fakeGrafanaClient({ dashboard });
      // Answer with points `gapMs` apart, as a datasource that honoured (or not)
      // the requested step would.
      queryDs.mockImplementation(async (req: { queries: Array<{ refId: string }> }) => {
        const points: Array<[number, number]> = [];
        for (let t = FROM; t <= TO; t += gapMs) points.push([t, 1]);
        return numberSeriesResponse(req.queries[0]!.refId, points);
      });
      const { server, call } = fakeServer();
      registerRenderDashboard(server, { registry: fakeRegistry(connections, client), config: config() });
      const result = (await call('render_dashboard', { dashboardUid: 'd297', fromMs: FROM, toMs: TO, connection: 'test' })) as {
        content: Array<{ text: string }>;
      };
      return { parsed: JSON.parse(result.content[0]!.text), queryDs };
    }

    it("substitutes the panel's 1m min interval for $__interval, and reports that step", async () => {
      const { parsed, queryDs } = await render([influxPanel(1, 'Writer (summarized)', '1m')], 60_000);
      const panel = parsed.panels[0];
      expect(panel.targets[0].resolvedQuery.query).toContain('GROUP BY time(1m) fill(0)');
      expect(queryDs.mock.calls[0]![0].queries[0].intervalMs).toBe(60_000);
      expect(panel.step).toMatchObject({ source: 'panel', panelInterval: '1m', requestedMs: 60_000, consistentWithRequested: true });
      expect(parsed.stepWarnings).toBeUndefined();
    });

    it('lifts a step Grafana did not honour to stepWarnings, naming the panel', async () => {
      const { parsed } = await render([influxPanel(1, 'Writer (summarized)', '1m'), influxPanel(2, 'Reader', '1m')], 5_000);
      expect(parsed.panels[0].step).toMatchObject({ requestedMs: 60_000, consistentWithRequested: false });
      expect(parsed.stepWarnings).toHaveLength(1);
      expect(parsed.stepWarnings[0]).toContain('"Writer (summarized)" (panel 1) (60000ms requested), "Reader" (panel 2)');
      expect(parsed.stepWarnings[0]).toContain("see each panel's step.note");
    });

    it("warns, naming the panel, when a min interval can't be read and the datasource chose the step", async () => {
      const { parsed } = await render([influxPanel(3, 'Odd', 'every minute')], 60_000);
      expect(parsed.panels[0].step).toMatchObject({ source: 'datasource-default', panelIntervalIgnored: 'every minute' });
      expect(parsed.stepWarnings).toEqual([
        expect.stringContaining('The min interval of "Odd" (panel 3) ("every minute") couldn\'t be read as a duration, so that panel ran'),
      ]);
      expect(parsed.stepWarnings[0]).toContain('execute_query_window and minIntervalMs');
    });
  });
});
