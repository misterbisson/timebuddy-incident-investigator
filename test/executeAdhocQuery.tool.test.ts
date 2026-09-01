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
    expect(result.content[0]!.text).toContain('Query refused');
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
