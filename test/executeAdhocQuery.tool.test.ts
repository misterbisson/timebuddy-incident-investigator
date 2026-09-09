import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerExecuteAdhocQuery } from '../src/tools/executeAdhocQuery.js';
import { registerAllTools } from '../src/tools/registerAll.js';
import type { AdhocQueryPolicy, Config, GrafanaConnection } from '../src/config.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { DatasourceInfo, DsQueryRequest, DsQueryResponse } from '../src/grafana/types.js';
import type { ConnectionRegistry } from '../src/grafana/registry.js';
import { ConnectionRegistry as RealConnectionRegistry } from '../src/grafana/registry.js';
import { fakeServer } from './toolTestHelpers.js';

const FROM = 1_760_000_000_000;
const TO = 1_760_003_600_000;

const connections: GrafanaConnection[] = [
  { id: 'staging', name: 'staging', url: 'https://metrics.staging.example.com', authType: 'bearer', token: 'x' },
  { id: 'prod', name: 'prod', url: 'https://metrics.prod.example.com', authType: 'bearer', token: 'y' },
];

let dataDir: string;

function config(adhocQueries: AdhocQueryPolicy[] = [], redactionPatterns: RegExp[] = []): Config {
  return {
    connections,
    logConnections: [],
    tlsVerify: true,
    requestTimeoutMs: 1000,
    screenshotTimeoutMs: 45000,
    maxConcurrency: 4,
    maxLookbackHours: 720,
    maxDataPoints: 2000,
    maxLogLines: 500,
    redactionPatterns,
    dataDir,
    webhookPort: 4318,
    webhookBindAddress: '127.0.0.1',
    screenshotRetentionHours: 168,
    auditMaxBytes: 0,
    auditKeep: 5,
    adhocQueries,
  };
}

function fakeClient(datasources: DatasourceInfo[], response?: DsQueryResponse) {
  const queryDs = vi.fn(async (req: DsQueryRequest): Promise<DsQueryResponse> => {
    if (response) return response;
    return {
      results: {
        A: {
          frames: [
            {
              schema: { refId: 'A', fields: [{ name: 'time', type: 'time' }, { name: 'value', type: 'number' }] },
              data: { values: [[Number(req.from), Number(req.to)], [1, 3]] },
            },
          ],
        },
      },
    };
  });
  const listDatasources = vi.fn(async () => datasources);
  return { client: { queryDs, listDatasources } as unknown as GrafanaClient, queryDs, listDatasources };
}

/** A registry backed by the real class, so adhocDatasourceTypes' host matching is genuinely exercised. */
function registryFor(cfg: Config, client: GrafanaClient): ConnectionRegistry {
  const registry = new RealConnectionRegistry(connections, cfg);
  vi.spyOn(registry, 'get').mockReturnValue(client);
  return registry;
}

const INFLUX: DatasourceInfo[] = [{ uid: 'influx1', id: 1, name: 'InfluxDB', type: 'influxdb' }];

async function callTool(cfg: Config, client: GrafanaClient, args: Record<string, unknown>) {
  const { server, call } = fakeServer();
  registerExecuteAdhocQuery(server, {
    registry: registryFor(cfg, client),
    logRegistry: undefined as never,
    config: cfg,
  });
  return (await call('execute_adhoc_query', args)) as { content: Array<{ text: string }>; isError?: boolean };
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'adhoc-tool-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('execute_adhoc_query registration', () => {
  it('is not registered when no workspace authorized it', () => {
    const { server, call } = fakeServer();
    const cfg = config([]);
    const { client } = fakeClient(INFLUX);
    registerAllTools(server, { registry: registryFor(cfg, client), logRegistry: undefined as never, config: cfg });
    return expect(call('execute_adhoc_query', {})).rejects.toThrow('No tool registered');
  });

  it('warns at startup when a policy host matches no connection', () => {
    // The likeliest .mcp.json typo. Without this it surfaces only as a per-call
    // "not authorized" refusal, which reads like a broken feature.
    const cfg = config([{ host: 'typo.example.com', datasourceTypes: ['influxdb'] }]);
    const { client } = fakeClient(INFLUX);
    const registry = registryFor(cfg, client);
    expect(registry.unmatchedAdhocHosts()).toEqual(['typo.example.com']);

    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { server } = fakeServer();
    registerAllTools(server, { registry, logRegistry: undefined as never, config: cfg });
    expect(warn.mock.calls.flat().join(' ')).toContain('typo.example.com');
  });

  it('does not warn when every policy host matches a connection', () => {
    const cfg = config([{ host: 'metrics.staging.example.com', datasourceTypes: ['influxdb'] }]);
    const { client } = fakeClient(INFLUX);
    expect(registryFor(cfg, client).unmatchedAdhocHosts()).toEqual([]);
  });

  it('is registered once some workspace authorized it', async () => {
    const { server, call } = fakeServer();
    const cfg = config([{ host: 'metrics.staging.example.com', datasourceTypes: ['influxdb'] }]);
    const { client } = fakeClient(INFLUX);
    registerAllTools(server, { registry: registryFor(cfg, client), logRegistry: undefined as never, config: cfg });
    await expect(call('execute_adhoc_query', {})).resolves.toBeDefined();
  });
});

describe('execute_adhoc_query authorization', () => {
  it('refuses a connection no policy names, even though the tool is registered', async () => {
    // The flag authorized staging; this call targets prod. Registration is
    // global (one tool list per MCP session) so the per-call check is what
    // actually scopes the capability.
    const cfg = config([{ host: 'metrics.staging.example.com', datasourceTypes: ['influxdb'] }]);
    const { client, queryDs } = fakeClient(INFLUX);
    const result = await callTool(cfg, client, {
      query: 'SELECT mean("value") FROM "cpu"',
      datasourceUid: 'influx1',
      fromMs: FROM,
      toMs: TO,
      connection: 'prod',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not authorized for ad-hoc queries');
    expect(queryDs).not.toHaveBeenCalled();
  });

  it('authorizes a connection named by a matchHosts alias', async () => {
    const aliased: GrafanaConnection[] = [
      { ...connections[0]!, matchHosts: ['metrics-vpn.staging.example.com'] },
      connections[1]!,
    ];
    const cfg = { ...config([{ host: 'metrics-vpn.staging.example.com', datasourceTypes: ['influxdb'] }]), connections: aliased };
    const { client } = fakeClient(INFLUX);
    const registry = new RealConnectionRegistry(aliased, cfg);
    vi.spyOn(registry, 'get').mockReturnValue(client);
    const { server, call } = fakeServer();
    registerExecuteAdhocQuery(server, { registry, logRegistry: undefined as never, config: cfg });
    const result = (await call('execute_adhoc_query', {
      query: 'SHOW MEASUREMENTS',
      datasourceUid: 'influx1',
      fromMs: FROM,
      toMs: TO,
      connection: 'staging',
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
  });

  it('refuses a datasource type the policy did not list', async () => {
    const cfg = config([{ host: 'metrics.staging.example.com', datasourceTypes: ['prometheus'] }]);
    const { client, queryDs } = fakeClient(INFLUX);
    const result = await callTool(cfg, client, {
      query: 'SELECT mean("value") FROM "cpu"',
      datasourceUid: 'influx1',
      fromMs: FROM,
      toMs: TO,
      connection: 'staging',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not authorized to query ad-hoc');
    expect(queryDs).not.toHaveBeenCalled();
  });

  it('refuses an authorized type that has no statement guard yet', async () => {
    // Authorization and verifiability are separate: an operator may be willing,
    // but without a guard for that query language we still refuse.
    const cfg = config([{ host: 'metrics.staging.example.com', datasourceTypes: ['postgres'] }]);
    const { client, queryDs } = fakeClient([{ uid: 'pg1', id: 2, name: 'Postgres', type: 'postgres' }]);
    const result = await callTool(cfg, client, {
      query: 'SELECT 1',
      datasourceUid: 'pg1',
      fromMs: FROM,
      toMs: TO,
      connection: 'staging',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('no read-only statement guard');
    expect(queryDs).not.toHaveBeenCalled();
  });

  it('refuses an unknown datasource uid', async () => {
    const cfg = config([{ host: 'metrics.staging.example.com', datasourceTypes: ['influxdb'] }]);
    const { client } = fakeClient(INFLUX);
    const result = await callTool(cfg, client, {
      query: 'SHOW MEASUREMENTS',
      datasourceUid: 'nope',
      fromMs: FROM,
      toMs: TO,
      connection: 'staging',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('No datasource with uid');
  });
});

describe('execute_adhoc_query execution', () => {
  const authorized = () => config([{ host: 'metrics.staging.example.com', datasourceTypes: ['influxdb'] }]);

  it('runs an allowed query and marks the result as adhoc', async () => {
    const cfg = authorized();
    const { client, queryDs } = fakeClient(INFLUX);
    const result = await callTool(cfg, client, {
      query: 'SELECT mean("value") FROM "cpu"',
      datasourceUid: 'influx1',
      fromMs: FROM,
      toMs: TO,
      connection: 'staging',
      // Passed explicitly: fakeServer invokes the handler directly, so zod's
      // .default(true) never runs here (same as executeQueryWindow's tests).
      includePoints: true,
    });
    const body = payload(result);
    expect(body.provenance).toBe('adhoc');
    expect(body.series[0].points).toHaveLength(2);
    expect(body.series[0].stats).toBeDefined();
    expect(queryDs).toHaveBeenCalledOnce();
    // Sent as raw InfluxQL, not a builder model.
    expect(queryDs.mock.calls[0]![0].queries[0]).toMatchObject({ query: 'SELECT mean("value") FROM "cpu"', rawQuery: true });
  });

  it('never reaches the datasource when the statement guard refuses', async () => {
    const cfg = authorized();
    const { client, queryDs } = fakeClient(INFLUX);
    const result = await callTool(cfg, client, {
      query: 'DROP MEASUREMENT "cpu"',
      datasourceUid: 'influx1',
      fromMs: FROM,
      toMs: TO,
      connection: 'staging',
    });
    expect(result.isError).toBe(true);
    // The refusal names the dialect the type dispatched to, so a caller who
    // meant PromQL and got an InfluxQL refusal can see they picked the wrong
    // datasource.
    expect(result.content[0]!.text).toContain('InfluxQL query refused');
    expect(queryDs).not.toHaveBeenCalled();
  });

  it('enforces the configured lookback cap', async () => {
    const cfg = { ...authorized(), maxLookbackHours: 1 };
    const { client } = fakeClient(INFLUX);
    const result = await callTool(cfg, client, {
      query: 'SHOW MEASUREMENTS',
      datasourceUid: 'influx1',
      fromMs: FROM,
      toMs: FROM + 10 * 3_600_000,
      connection: 'staging',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('MAX_LOOKBACK_HOURS');
  });

  it('omits raw points but keeps stats when includePoints is false', async () => {
    const cfg = authorized();
    const { client } = fakeClient(INFLUX);
    const body = payload(
      await callTool(cfg, client, {
        query: 'SHOW MEASUREMENTS',
        datasourceUid: 'influx1',
        fromMs: FROM,
        toMs: TO,
        connection: 'staging',
        includePoints: false,
      }),
    );
    expect(body.series[0].points).toBeUndefined();
    expect(body.series[0].stats).toBeDefined();
  });

  it('surfaces a datasource error without throwing', async () => {
    const cfg = authorized();
    const { client } = fakeClient(INFLUX, { results: { A: { error: 'expected identifier' } } });
    const body = payload(
      await callTool(cfg, client, {
        query: 'SELECT bogus FROM',
        datasourceUid: 'influx1',
        fromMs: FROM,
        toMs: TO,
        connection: 'staging',
      }),
    );
    expect(body.errors.A).toBe('expected identifier');
  });
});

describe('execute_adhoc_query audit and redaction', () => {
  const authorized = (patterns: RegExp[] = []) =>
    config([{ host: 'metrics.staging.example.com', datasourceTypes: ['influxdb'] }], patterns);

  async function auditLines(): Promise<Array<Record<string, any>>> {
    const raw = await readFile(join(dataDir, 'audit.jsonl'), 'utf8');
    return raw.trim().split('\n').map((l) => JSON.parse(l));
  }

  it('records a replayable Explore URL in the audit log', async () => {
    const cfg = authorized();
    const { client } = fakeClient(INFLUX);
    await callTool(cfg, client, {
      query: 'SELECT mean("value") FROM "cpu"',
      datasourceUid: 'influx1',
      fromMs: FROM,
      toMs: TO,
      connection: 'staging',
    });
    const [record] = await auditLines();
    expect(record!.tool).toBe('execute_adhoc_query');
    expect(record!.argsSummary.exploreUrl).toContain('https://metrics.staging.example.com/explore');
    expect(record!.argsSummary.exploreUrl).toContain('schemaVersion=1');
  });

  it('records the URL even for a query the guard refused', async () => {
    // A refused query is exactly the one an auditor wants to reproduce.
    const cfg = authorized();
    const { client } = fakeClient(INFLUX);
    await callTool(cfg, client, {
      query: 'DROP MEASUREMENT "cpu"',
      datasourceUid: 'influx1',
      fromMs: FROM,
      toMs: TO,
      connection: 'staging',
    });
    const [record] = await auditLines();
    expect(record!.outcome).toBe('error');
    expect(record!.argsSummary.exploreUrl).toContain('/explore');
  });

  it('replays the statement that actually ran, not the raw input', async () => {
    // docs/TOOLS.md promises the URL "re-runs exactly that query". The tool
    // executes verdict.statement (comments collapsed), so a URL built from the
    // raw text would replay something subtly different from what ran.
    const cfg = authorized();
    const { client, queryDs } = fakeClient(INFLUX);
    const result = await callTool(cfg, client, {
      query: 'SELECT mean("value") /* note */ FROM "cpu"',
      datasourceUid: 'influx1',
      fromMs: FROM,
      toMs: TO,
      connection: 'staging',
    });
    const sent = queryDs.mock.calls[0]![0].queries[0]!.query;
    const inUrl = JSON.parse(
      new URL(payload(result).exploreUrl).searchParams.get('panes')!,
    ).timebuddy.queries[0].query;
    expect(inUrl).toBe(sent);
    expect(inUrl).not.toContain('/* note */');
  });

  it('replays what was asked when the query is refused', async () => {
    // Refusal path deliberately keeps the raw text: the scanned form of a
    // refused query may not stand alone, and what an auditor wants to reproduce
    // is what was attempted.
    const cfg = authorized();
    const { client } = fakeClient(INFLUX);
    await callTool(cfg, client, {
      query: 'DROP MEASUREMENT "cpu"',
      datasourceUid: 'influx1',
      fromMs: FROM,
      toMs: TO,
      connection: 'staging',
    });
    const [record] = await auditLines();
    const inUrl = JSON.parse(
      new URL(record!.argsSummary.exploreUrl).searchParams.get('panes')!,
    ).timebuddy.queries[0].query;
    expect(inUrl).toBe('DROP MEASUREMENT "cpu"');
  });

  it('leaves the Explore URL intact when a redaction pattern matches inside it', async () => {
    // The exemption's whole reason for existing: redactString rewrites *inside*
    // strings, so without it a matched identifier returns a broken link rather
    // than a masked one — and it would mask nothing, since the model wrote this
    // query and already has the identifier in context.
    const cfg = authorized([/acct-\d{6}/]);
    const { client } = fakeClient(INFLUX);
    const result = await callTool(cfg, client, {
      query: `SELECT mean("value") FROM "cpu" WHERE "account" = 'acct-123456'`,
      datasourceUid: 'influx1',
      fromMs: FROM,
      toMs: TO,
      connection: 'staging',
    });
    const body = payload(result);
    expect(body.exploreUrl).toContain('acct-123456');
    expect(body.exploreUrl).not.toContain('REDACTED');
    // The query field itself is NOT exempt — only the URL is.
    expect(body.query).toContain('[REDACTED]');

    const [record] = await auditLines();
    expect(record!.argsSummary.exploreUrl).toContain('acct-123456');
    expect(record!.argsSummary.query).toContain('[REDACTED]');
  });
});

const PROM: DatasourceInfo[] = [{ uid: 'prom1', id: 3, name: 'Prometheus', type: 'prometheus' }];

/** A Prometheus-shaped range response: one frame per series, at the exact timestamps given. */
function promFrames(...seriesTimes: number[][]): DsQueryResponse {
  return {
    results: {
      A: {
        frames: seriesTimes.map((times, i) => ({
          schema: {
            refId: 'A',
            fields: [
              { name: 'Time', type: 'time' },
              { name: 'Value', type: 'number', labels: { job: `web-${i}` } },
            ],
          },
          data: { values: [times, times.map(() => 1)] },
        })),
      },
    },
  };
}

/** One series of `count` points spaced `stepMs` apart from FROM — the dense, unsparse case. */
function promResponse(stepMs: number, count: number): DsQueryResponse {
  return promFrames(Array.from({ length: count }, (_, i) => FROM + i * stepMs));
}

describe('execute_adhoc_query PromQL', () => {
  const authorized = () => config([{ host: 'metrics.staging.example.com', datasourceTypes: ['prometheus'] }]);

  const base = { datasourceUid: 'prom1', fromMs: FROM, toMs: TO, connection: 'staging', includePoints: true };

  it('runs a range query at the requested step and sends it as a PromQL target', async () => {
    const cfg = authorized();
    const { client, queryDs } = fakeClient(PROM, promResponse(60_000, 61));
    const body = payload(
      await callTool(cfg, client, { ...base, query: 'count_over_time(app_action_total[1m])', stepSeconds: 60 }),
    );
    expect(body.provenance).toBe('adhoc');
    expect(body.queryType).toBe('range');
    // Both the string and numeric step forms, so the step survives whichever
    // field the instance's Prometheus backend reads (see #200).
    expect(queryDs.mock.calls[0]![0].queries[0]).toMatchObject({
      expr: 'count_over_time(app_action_total[1m])',
      range: true,
      instant: false,
      interval: '60s',
      intervalMs: 60_000,
    });
    // Not the InfluxQL shape.
    expect(queryDs.mock.calls[0]![0].queries[0]!.rawQuery).toBeUndefined();
  });

  it('reports a dense series as exactly the requested step, with nothing to reinterpret', async () => {
    const cfg = authorized();
    const { client } = fakeClient(PROM, promResponse(60_000, 61));
    const body = payload(await callTool(cfg, client, { ...base, query: 'up', stepSeconds: 60 }));
    expect(body.step).toMatchObject({
      requestedMs: 60_000,
      observedGapGcdMs: 60_000,
      observedMinGapMs: 60_000,
      seriesMeasured: 1,
      consistentWithRequested: true,
    });
    expect(body.step.note).toBeUndefined();
  });

  it('flags a datasource that evaluated at a different step than requested', async () => {
    // The failure #200 documents, made visible instead of assumed away: 15000ms
    // gaps cannot be produced by a 60000ms step, so this is proof rather than
    // inference.
    const cfg = authorized();
    const { client } = fakeClient(PROM, promResponse(15_000, 241));
    const body = payload(await callTool(cfg, client, { ...base, query: 'increase(x[1m])', stepSeconds: 60 }));
    expect(body.step.consistentWithRequested).toBe(false);
    expect(body.step.observedGapGcdMs).toBe(15_000);
    expect(body.step.note).toContain('divisor of 15000ms, which is not a multiple of the requested 60000ms');
  });

  it('does not mistake a sparse metric for a step override', async () => {
    // The headline probe in #212 — count_over_time on a metric that emits a few
    // events an hour. Prometheus evaluates on the 60s grid but returns a point
    // only where the range vector had samples, so the gaps are wide *multiples*
    // of the step. Calling that a 900000ms step would turn a correct
    // scrape-density measurement into an apparent 15x error, because the skill
    // tells the agent to reread every number against the reported step.
    const cfg = authorized();
    const sparse = [FROM, FROM + 60_000, FROM + 960_000, FROM + 1_020_000, FROM + 2_460_000];
    const { client } = fakeClient(PROM, promFrames(sparse));
    const body = payload(
      await callTool(cfg, client, { ...base, query: 'count_over_time(app_action_total[1m])', stepSeconds: 60 }),
    );
    expect(body.step.consistentWithRequested).toBe(true);
    expect(body.step.observedGapGcdMs).toBe(60_000);
    expect(body.step.observedMinGapMs).toBe(60_000);
    expect(body.step.note).toBeUndefined();
  });

  it('explains wide-but-consistent spacing as sparsity rather than a mismatch', async () => {
    // Same shape, but with no gap as tight as the step: every gap is still a
    // multiple of it, so the note says "not evidence of a different step".
    const cfg = authorized();
    const { client } = fakeClient(PROM, promFrames([FROM, FROM + 300_000, FROM + 900_000]));
    const body = payload(await callTool(cfg, client, { ...base, query: 'up', stepSeconds: 60 }));
    expect(body.step).toMatchObject({ consistentWithRequested: true, observedGapGcdMs: 300_000, observedMinGapMs: 300_000 });
    expect(body.step.note).toContain('not evidence of a different step');
  });

  it('measures across every series, not the first one that has two points', async () => {
    // A single-point first series used to decide the whole report — either
    // claiming nothing was measurable, or reporting that one series' spacing
    // while denser ones went unread.
    const cfg = authorized();
    const { client } = fakeClient(
      PROM,
      promFrames([FROM], [FROM, FROM + 120_000], [FROM, FROM + 60_000, FROM + 120_000]),
    );
    const body = payload(await callTool(cfg, client, { ...base, query: 'up', stepSeconds: 60 }));
    expect(body.step).toMatchObject({ seriesMeasured: 2, observedMinGapMs: 60_000, consistentWithRequested: true });
  });

  it('measures the step before the response clamp downsamples the series', async () => {
    // A datasource that returns more points than the step implies (one that
    // aligns to its own retention rather than the requested step) trips
    // clampSeriesPoints, which strides the *emitted* points. Measuring after it
    // would report the stride and claim the datasource ignored the step.
    const cfg = { ...authorized(), maxDataPoints: 101 };
    const { client } = fakeClient(PROM, promResponse(1_000, 500));
    const body = payload(
      await callTool(cfg, client, { ...base, query: 'up', toMs: FROM + 100_000, stepSeconds: 1 }),
    );
    expect(body.step).toMatchObject({ observedMinGapMs: 1_000, observedGapGcdMs: 1_000, consistentWithRequested: true });
    expect(body.series[0].pointsTotal).toBe(500);
    expect(body.series[0].points.length).toBe(101);
  });

  it('says nothing can be measured when no series has two distinct timestamps', async () => {
    const cfg = authorized();
    const { client } = fakeClient(PROM, promFrames([FROM], [FROM + 30_000]));
    const body = payload(await callTool(cfg, client, { ...base, query: 'up', stepSeconds: 60 }));
    expect(body.step.requestedMs).toBe(60_000);
    expect(body.step.observedGapGcdMs).toBeUndefined();
    expect(body.step.consistentWithRequested).toBeUndefined();
    expect(body.step.note).toContain('matched no data in this window');
  });

  it('refuses a range query with no stepSeconds instead of inferring one', async () => {
    const cfg = authorized();
    const { client, queryDs } = fakeClient(PROM);
    const result = await callTool(cfg, client, { ...base, query: 'rate(x[1m])' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('require an explicit "stepSeconds"');
    expect(queryDs).not.toHaveBeenCalled();
  });

  it('refuses a step finer than MAX_DATA_POINTS allows, naming the smallest that fits', async () => {
    const cfg = { ...authorized(), maxDataPoints: 100 };
    const { client, queryDs } = fakeClient(PROM);
    const result = await callTool(cfg, client, { ...base, query: 'up', stepSeconds: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('MAX_DATA_POINTS=100');
    expect(result.content[0]!.text).toMatch(/stepSeconds >= 37/);
    expect(queryDs).not.toHaveBeenCalled();
  });

  it('runs an instant query at the window end', async () => {
    const cfg = authorized();
    const { client, queryDs } = fakeClient(PROM, promResponse(0, 1));
    const body = payload(await callTool(cfg, client, { ...base, query: 'up', queryType: 'instant' }));
    expect(body.queryType).toBe('instant');
    expect(body.evaluatedAtMs).toBe(TO);
    expect(body.step).toBeUndefined();
    expect(queryDs.mock.calls[0]![0].queries[0]).toMatchObject({ expr: 'up', instant: true, range: false });
    expect(queryDs.mock.calls[0]![0].queries[0]!.interval).toBeUndefined();
  });

  it('refuses stepSeconds on an instant query rather than ignoring it', async () => {
    const cfg = authorized();
    const { client, queryDs } = fakeClient(PROM);
    const result = await callTool(cfg, client, { ...base, query: 'up', queryType: 'instant', stepSeconds: 60 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('does not apply to instant PromQL');
    expect(queryDs).not.toHaveBeenCalled();
  });

  it('names PromQL when the guard refuses, so the dispatch is visible', async () => {
    const cfg = authorized();
    const { client, queryDs } = fakeClient(PROM);
    const result = await callTool(cfg, client, { ...base, query: 'up; down', stepSeconds: 60 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('PromQL query refused');
    expect(queryDs).not.toHaveBeenCalled();
  });

  it('builds a Prometheus-shaped Explore pane carrying the expression and the step', async () => {
    const cfg = authorized();
    const { client } = fakeClient(PROM, promResponse(60_000, 61));
    const body = payload(await callTool(cfg, client, { ...base, query: 'sum(rate(x[5m]))', stepSeconds: 60 }));
    const pane = JSON.parse(new URL(body.exploreUrl).searchParams.get('panes')!).timebuddy;
    expect(pane.queries[0]).toMatchObject({ expr: 'sum(rate(x[5m]))', range: true, instant: false, interval: '60s' });
    // An InfluxQL-shaped pane would open Explore empty against Prometheus.
    expect(pane.queries[0].query).toBeUndefined();
    expect(pane.range).toEqual({ from: String(FROM), to: String(TO) });
  });

  it('records a replayable URL for a dialect-parameter refusal, not just a guard refusal', async () => {
    // The likeliest first attempt now that stepSeconds is required. The refusal
    // comes from dialect.prepare(), which used to run before the URL was built,
    // so this record had no link — while a guard refusal on the same call did.
    // README and docs/TOOLS.md both promise refused queries are recorded with
    // one, so the trail can't be selective about which refusals qualify.
    const cfg = authorized();
    const { client } = fakeClient(PROM);
    await callTool(cfg, client, { ...base, query: 'rate(x[1m])' });
    const raw = await readFile(join(dataDir, 'audit.jsonl'), 'utf8');
    const record = JSON.parse(raw.trim().split('\n')[0]!);
    expect(record.outcome).toBe('error');
    expect(record.argsSummary.exploreUrl).toContain('/explore');
    const pane = JSON.parse(new URL(record.argsSummary.exploreUrl).searchParams.get('panes')!).timebuddy;
    expect(pane.queries[0].expr).toBe('rate(x[1m])');
    // No step in the link, because the step was never valid — replaying at a
    // resolution nobody chose is the thing this whole path refuses to do.
    expect(pane.queries[0].interval).toBeUndefined();
  });

  it('records a replayable URL when the step exceeds the point budget', async () => {
    const cfg = { ...authorized(), maxDataPoints: 100 };
    const { client } = fakeClient(PROM);
    await callTool(cfg, client, { ...base, query: 'up', stepSeconds: 1 });
    const raw = await readFile(join(dataDir, 'audit.jsonl'), 'utf8');
    const record = JSON.parse(raw.trim().split('\n')[0]!);
    expect(record.outcome).toBe('error');
    expect(record.argsSummary.exploreUrl).toContain('/explore');
  });

  it('records queryType and stepSeconds in the audit record', async () => {
    const cfg = authorized();
    const { client } = fakeClient(PROM, promResponse(60_000, 61));
    await callTool(cfg, client, { ...base, query: 'up', stepSeconds: 60 });
    const raw = await readFile(join(dataDir, 'audit.jsonl'), 'utf8');
    const record = JSON.parse(raw.trim().split('\n')[0]!);
    expect(record.argsSummary.stepSeconds).toBe(60);
    expect(record.argsSummary.exploreUrl).toContain('/explore');
  });
});

describe('execute_adhoc_query dialect parameters', () => {
  const influxAuthorized = () => config([{ host: 'metrics.staging.example.com', datasourceTypes: ['influxdb'] }]);

  it('refuses stepSeconds against an InfluxDB datasource rather than ignoring it', async () => {
    // Accepting and ignoring a resolution parameter is the same class of bug as
    // #200: the caller believes they set the step, and nothing says otherwise.
    const cfg = influxAuthorized();
    const { client, queryDs } = fakeClient(INFLUX);
    const result = await callTool(cfg, client, {
      query: 'SELECT mean("value") FROM "cpu"',
      datasourceUid: 'influx1',
      fromMs: FROM,
      toMs: TO,
      connection: 'staging',
      stepSeconds: 60,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('does not apply to InfluxQL');
    expect(result.content[0]!.text).toContain('GROUP BY time(...)');
    expect(queryDs).not.toHaveBeenCalled();
  });

  it('refuses queryType against an InfluxDB datasource', async () => {
    const cfg = influxAuthorized();
    const { client } = fakeClient(INFLUX);
    const result = await callTool(cfg, client, {
      query: 'SHOW MEASUREMENTS',
      datasourceUid: 'influx1',
      fromMs: FROM,
      toMs: TO,
      connection: 'staging',
      queryType: 'instant',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('"queryType" does not apply to InfluxQL');
  });

  it('still returns no step fields for an InfluxQL query', async () => {
    const cfg = influxAuthorized();
    const { client } = fakeClient(INFLUX);
    const body = payload(
      await callTool(cfg, client, {
        query: 'SELECT mean("value") FROM "cpu"',
        datasourceUid: 'influx1',
        fromMs: FROM,
        toMs: TO,
        connection: 'staging',
      }),
    );
    expect(body.step).toBeUndefined();
    expect(body.queryType).toBeUndefined();
  });
});
