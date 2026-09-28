import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerSearchLogs } from '../src/tools/searchLogs.js';
import { registerListLogSources } from '../src/tools/listLogSources.js';
import { registerCorrelateLogs } from '../src/tools/correlateLogs.js';
import type { Config, GrafanaConnection, LogConnection } from '../src/config.js';
import { createActivityLog } from '../src/activity/activityLog.js';
import { fakeGraylogClient, fakeLogRegistry, fakeRegistry, fakeServer } from './toolTestHelpers.js';
import { fakeLokiClient, LOKI_DS, type FixtureLine } from './lokiFixtures.js';

// #265: Loki datasources reached through a Grafana connection are log sources
// for list_log_sources / search_logs / correlate_logs.

const T0 = Date.parse('2026-03-01T10:00:00Z');
const grafana: GrafanaConnection[] = [
  { id: 'prod', name: 'Prod', url: 'https://grafana.example.com', authType: 'bearer', token: 'x', tags: ['prod'] },
];
const graylog: LogConnection[] = [
  { id: 'gl', name: 'Graylog', sourceType: 'graylog', url: 'https://graylog.example.com', authType: 'token', token: 'y' },
];
const SOURCE = 'prod/logs1';

function config(redactionPatterns: RegExp[] = []): Config {
  return {
    connections: grafana,
    logConnections: [],
    tlsVerify: true,
    requestTimeoutMs: 1000,
    screenshotTimeoutMs: 45000,
    maxConcurrency: 4,
    maxLookbackHours: 720,
    maxDataPoints: 2000,
    maxLogLines: 500,
    redactionPatterns,
    dataDir: '.data',
    webhookPort: 4318,
  };
}

function setup(opts: { linesByExpr?: Record<string, FixtureLine[] | Error>; labelNames?: string[]; withGraylog?: boolean; redact?: RegExp[] } = {}) {
  const loki = fakeLokiClient({ linesByExpr: opts.linesByExpr, labelNames: opts.labelNames });
  const activityLog = createActivityLog();
  const { server, call, inputSchema } = fakeServer();
  const ctx = {
    registry: fakeRegistry(grafana, loki.client),
    logRegistry: fakeLogRegistry(opts.withGraylog ? graylog : [], fakeGraylogClient({ messages: [] }).client),
    config: config(opts.redact),
    activityLog,
  } as never;
  registerSearchLogs(server, ctx);
  registerListLogSources(server, ctx);
  registerCorrelateLogs(server, ctx);
  const run = async (name: string, args: Record<string, unknown>) => {
    const r = (await call(name, args)) as { content: Array<{ text: string }>; isError?: boolean };
    return { isError: r.isError, text: r.content[0]!.text, body: r.isError ? undefined : JSON.parse(r.content[0]!.text) };
  };
  return { run, activityLog, queryDs: loki.queryDs, getLokiLabelNames: loki.getLokiLabelNames, inputSchema };
}

const lines: FixtureLine[] = [
  { t: T0, line: '{"request_id":"r1","msg":"cart failed for acct-12345"}', labels: { app: 'checkout', level: 'error' } },
  { t: T0 + 1000, line: '{"request_id":"r2","msg":"ok"}', labels: { app: 'checkout', level: 'info' } },
];

describe('list_log_sources with Loki', () => {
  it('lists Loki datasources alongside Graylog connections', async () => {
    const { run } = setup({ withGraylog: true });
    const { body } = await run('list_log_sources', {});
    expect(body.sources).toEqual([
      { sourceType: 'graylog', id: 'gl', name: 'Graylog' },
      { sourceType: 'loki', id: SOURCE, name: LOKI_DS.name, tags: ['prod'], grafanaConnection: 'prod', datasourceUid: 'logs1' },
    ]);
  });

  it('lists a Loki source\'s stream label names when asked about it', async () => {
    const { run } = setup({ labelNames: ['app', 'env', 'level'] });
    const { body } = await run('list_log_sources', { connection: SOURCE });
    expect(body.labels).toEqual(['app', 'env', 'level']);
    expect(body.streams).toBeUndefined();
  });

  // #277: Loki only lists labels seen in a time range, so the window is
  // always sent and always reported.
  it('lists label names over the window it was given, and reports it', async () => {
    const { run, getLokiLabelNames } = setup({ labelNames: ['app'] });
    const { body } = await run('list_log_sources', { connection: SOURCE, startsAtMs: T0, endsAtMs: T0 + 2 * 3_600_000 });
    expect(getLokiLabelNames).toHaveBeenCalledWith('logs1', { fromMs: T0, toMs: T0 + 2 * 3_600_000 });
    expect(body.labelWindow).toEqual({ from: '2026-03-01T10:00:00.000Z', to: '2026-03-01T12:00:00.000Z', defaulted: false });
  });

  it('defaults the label window to the 24 hours before now, and says so', async () => {
    const { run, getLokiLabelNames } = setup({ labelNames: ['app'] });
    const before = Date.now();
    const { body } = await run('list_log_sources', { connection: SOURCE });
    const [, window] = getLokiLabelNames.mock.calls[0]!;
    expect(window.toMs).toBeGreaterThanOrEqual(before);
    expect(window.toMs - window.fromMs).toBe(24 * 3_600_000);
    expect(body.labelWindow.defaulted).toBe(true);
  });

  it('refuses a window when there are no Loki label names for it to scope', async () => {
    const { run } = setup({ withGraylog: true });
    const noConnection = await run('list_log_sources', { startsAtMs: T0 });
    expect(noConnection.isError).toBe(true);
    expect(noConnection.text).toMatch(/only scope a Loki source/);
    const graylogConnection = await run('list_log_sources', { connection: 'gl', startsAtMs: T0 });
    expect(graylogConnection.isError).toBe(true);
    expect(graylogConnection.text).toMatch(/only scope a Loki source/);
  });
});

describe('search_logs with Loki', () => {
  it('runs LogQL against the Loki source and returns lines, labels, and an Explore link', async () => {
    const q = '{app="checkout"} |= "request_id" | json';
    const { run, queryDs } = setup({ linesByExpr: { [q]: lines } });
    const { body } = await run('search_logs', { query: q, startsAtMs: T0, endsAtMs: T0 + 60_000, connection: SOURCE });

    expect(body.sourceType).toBe('loki');
    expect(body.connectionId).toBe(SOURCE);
    expect(body.datasource).toEqual({ uid: 'logs1', name: LOKI_DS.name });
    expect(body.returned).toBe(2);
    expect(body.truncated).toBe(false);
    expect(body.messages[0]).toMatchObject({ timestamp: '2026-03-01T10:00:01.000Z', labels: { level: 'info' } });
    expect(queryDs.mock.calls[0]![0].queries[0]).toMatchObject({ expr: q, maxLines: 500 });

    const url = new URL(body.url);
    expect(url.origin + url.pathname).toBe('https://grafana.example.com/explore');
    const pane = JSON.parse(url.searchParams.get('panes')!).timebuddy;
    expect(pane.queries[0]).toMatchObject({ expr: q, queryType: 'range', datasource: { type: 'loki', uid: 'logs1' } });
  });

  it('defaults to the sole Loki source when nothing else is configured', async () => {
    const { run } = setup({ linesByExpr: { '{app="checkout"}': lines } });
    const { body } = await run('search_logs', { query: '{app="checkout"}', startsAtMs: T0, endsAtMs: T0 + 60_000 });
    expect(body.connectionId).toBe(SOURCE);
  });

  it('refuses to guess between Graylog and Loki when both exist', async () => {
    const { run, queryDs } = setup({ withGraylog: true });
    const r = await run('search_logs', { query: '{app="checkout"}', startsAtMs: T0, endsAtMs: T0 + 60_000 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Could not determine which log source/);
    expect(queryDs).not.toHaveBeenCalled();
  });

  it('says so when the cap was reached, since Loki gives no total', async () => {
    const { run } = setup({ linesByExpr: { '{app="checkout"}': lines } });
    const { body } = await run('search_logs', { query: '{app="checkout"}', startsAtMs: T0, endsAtMs: T0 + 60_000, limit: 1, connection: SOURCE });
    expect(body.truncated).toBe(true);
    expect(body.truncatedNote).toMatch(/no total match count/);
  });

  it('refuses streamId, which means nothing to Loki', async () => {
    const { run, queryDs } = setup();
    const r = await run('search_logs', { query: '{app="checkout"}', startsAtMs: T0, endsAtMs: T0 + 1, streamId: 's1', connection: SOURCE });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/"streamId" is Graylog-only/);
    expect(queryDs).not.toHaveBeenCalled();
  });

  it('refuses a metric query rather than returning no lines', async () => {
    const { run, queryDs } = setup();
    const r = await run('search_logs', { query: 'sum(rate({app="x"}[1m]))', startsAtMs: T0, endsAtMs: T0 + 1, connection: SOURCE });
    expect(r.text).toMatch(/metric query/);
    expect(queryDs).not.toHaveBeenCalled();
  });

  it('redacts line content like every other log result', async () => {
    const { run } = setup({ linesByExpr: { '{app="checkout"}': lines }, redact: [/acct-\d+/g] });
    const { text } = await run('search_logs', { query: '{app="checkout"}', startsAtMs: T0, endsAtMs: T0 + 60_000, connection: SOURCE });
    expect(text).not.toContain('acct-12345');
  });

  it('records the search in the activity log under the Loki source', async () => {
    const { run, activityLog } = setup({ linesByExpr: { '{app="checkout"}': lines } });
    await run('search_logs', { query: '{app="checkout"}', startsAtMs: T0, endsAtMs: T0 + 60_000, connection: SOURCE });
    expect(activityLog.list()[0]).toMatchObject({
      kind: 'log',
      toolName: 'search_logs',
      connectionId: SOURCE,
      connectionName: `${LOKI_DS.name} (Prod)`,
      query: '{app="checkout"}',
      resultCount: 2,
    });
  });
});

describe('correlate_logs with Loki', () => {
  const front: FixtureLine[] = [
    { t: T0, line: '{"request_id":"r1"}', labels: { app: 'frontend' } },
    { t: T0 + 1, line: '{"request_id":"r2"}', labels: { app: 'frontend' } },
  ];
  const back: FixtureLine[] = [{ t: T0 + 2, line: '{"request_id":"r1"}', labels: { app: 'backend' } }];

  it('joins two Loki streams on an extracted field, with a per-stream Explore link', async () => {
    const { run } = setup({ linesByExpr: { '{app="frontend"}': front, '{app="backend"}': back } });
    const { body } = await run('correlate_logs', {
      query: 'loki({app="frontend"})[5m] and on(request_id) loki({app="backend"})[5m]',
      startsAtMs: T0,
      endsAtMs: T0 + 60_000,
      connection: SOURCE,
    });
    expect(body.sourceType).toBe('loki');
    expect(body.correlatedCount).toBe(1);
    expect(body.url).toBeUndefined();
    expect(body.streams.map((s: { selector: string }) => s.selector)).toEqual(['{app="frontend"}', '{app="backend"}']);
    expect(body.streams[0].url).toContain('https://grafana.example.com/explore');
  });

  it('refuses a query written with graylog(...) streams against a Loki source', async () => {
    const { run, queryDs } = setup();
    const r = await run('correlate_logs', {
      query: 'graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]',
      startsAtMs: T0,
      endsAtMs: T0 + 60_000,
      connection: SOURCE,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/is a loki log source, but the query writes stream\(s\) as graylog\(\.\.\.\)/);
    expect(queryDs).not.toHaveBeenCalled();
  });

  it('refuses an anti-join whose truncated right side has no total to check against', async () => {
    const { run } = setup({ linesByExpr: { '{app="frontend"}': front, '{app="backend"}': [...back, ...back] } });
    const r = await run('correlate_logs', {
      query: 'loki({app="frontend"})[5m] unless on(request_id) loki({app="backend"})[5m]',
      startsAtMs: T0,
      endsAtMs: T0 + 60_000,
      limit: 2,
      connection: SOURCE,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/returned the full 2-line cap \(Loki reports no total\)/);
    // #281: the cap named is the one this call ran with, not MAX_LOG_LINES,
    // and the advice is to raise it: a smaller limit only truncates more.
    expect(r.text).toMatch(/truncated at the 2-line cap/);
    expect(r.text).not.toMatch(/500-line cap|smaller/);
    expect(r.text).toMatch(/raise "limit" \(up to MAX_LOG_LINES=500\)/);
  });

  it('advises raising MAX_LOG_LINES, not limit, when the call already ran at that cap', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ t: T0 + i, line: `{"request_id":"b${i}"}`, labels: { app: 'backend' } }));
    const { run } = setup({ linesByExpr: { '{app="frontend"}': front, '{app="backend"}': many } });
    const r = await run('correlate_logs', {
      query: 'loki({app="frontend"})[5m] unless on(request_id) loki({app="backend"})[5m]',
      startsAtMs: T0,
      endsAtMs: T0 + 60_000,
      connection: SOURCE,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/truncated at the 500-line cap/);
    expect(r.text).toMatch(/raise MAX_LOG_LINES/);
    expect(r.text).not.toMatch(/raise "limit"/);
  });

  // #281: the metric-query refusal told correlate_logs callers to use
  // execute_adhoc_query, which can't be put inside a join.
  it('refuses a non-selector inside loki(...) in terms of the join, not search_logs', async () => {
    const { run } = setup({});
    const r = await run('correlate_logs', {
      query: 'loki(service:frontend)[5m] and on(request_id) loki({app="backend"})[5m]',
      startsAtMs: T0,
      endsAtMs: T0 + 60_000,
      connection: SOURCE,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/loki\(\.\.\.\) stream in correlate_logs takes a stream selector/);
    expect(r.text).not.toMatch(/search_logs returns|execute_adhoc_query/);
  });
});

// #280: `limit` was z.number(), so -5 and 2.5 reached the log source.
describe('the log tools\' limit schema', () => {
  it.each(['search_logs', 'correlate_logs'])('%s accepts only a positive whole number', (tool) => {
    const limit = z.object(setup().inputSchema(tool)).shape.limit;
    expect(limit.safeParse(50).success).toBe(true);
    expect(limit.safeParse(undefined).success).toBe(true);
    for (const bad of [-5, 0, 2.5]) expect(limit.safeParse(bad).success).toBe(false);
  });
});
