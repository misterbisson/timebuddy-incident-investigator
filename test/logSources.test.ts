import { describe, expect, it, vi } from 'vitest';
import { listLogSources, resolveLogSource } from '../src/logs/sources.js';
import type { GrafanaConnection, LogConnection } from '../src/config.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { ConnectionRegistry } from '../src/grafana/registry.js';
import type { DatasourceInfo } from '../src/grafana/types.js';
import { fakeGraylogClient, fakeLogRegistry } from './toolTestHelpers.js';

const graylog: LogConnection = { id: 'gl', name: 'Graylog', sourceType: 'graylog', url: 'https://graylog.example.com', authType: 'token', token: 'x', tags: ['prod'] };
const grafanaA: GrafanaConnection = { id: 'prod-us', name: 'Prod US', url: 'https://grafana-us.example.com', authType: 'bearer', token: 'a', tags: ['prod', 'us'] };
const grafanaB: GrafanaConnection = { id: 'prod-eu', name: 'Prod EU', url: 'https://grafana-eu.example.com', authType: 'bearer', token: 'b' };

const LOKI: DatasourceInfo = { uid: 'lk1', id: 1, name: 'Example-Logs', type: 'loki' };
const PROM: DatasourceInfo = { uid: 'pm1', id: 2, name: 'Example-Metrics', type: 'prometheus' };

/** A Grafana registry whose per-connection datasource lists (or failures) are given explicitly. */
function grafanaRegistry(byConnection: Record<string, DatasourceInfo[] | Error>, connections = [grafanaA, grafanaB]): ConnectionRegistry {
  const clients = new Map<string, GrafanaClient>();
  for (const c of connections) {
    const answer = byConnection[c.id] ?? [];
    clients.set(c.id, {
      listDatasources: vi.fn(async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      }),
    } as unknown as GrafanaClient);
  }
  return { list: () => connections, get: (id: string) => clients.get(id)! } as unknown as ConnectionRegistry;
}

const graylogRegistry = () => fakeLogRegistry([graylog], fakeGraylogClient({}).client);

describe('listLogSources', () => {
  it('lists Graylog connections and every Loki datasource, tagged like its Grafana connection', async () => {
    const { sources, problems } = await listLogSources(graylogRegistry(), grafanaRegistry({ 'prod-us': [LOKI, PROM] }));
    expect(sources).toEqual([
      { sourceType: 'graylog', id: 'gl', name: 'Graylog', tags: ['prod'] },
      { sourceType: 'loki', id: 'prod-us/lk1', name: 'Example-Logs', tags: ['prod', 'us'], grafanaConnection: 'prod-us', datasourceUid: 'lk1' },
    ]);
    expect(problems).toEqual([]);
  });

  it('reports a Grafana connection whose datasources could not be read instead of failing the listing', async () => {
    const { sources, problems } = await listLogSources(graylogRegistry(), grafanaRegistry({ 'prod-us': [LOKI], 'prod-eu': new Error('403 forbidden') }));
    expect(sources.map((s) => s.id)).toEqual(['gl', 'prod-us/lk1']);
    expect(problems).toEqual([{ connection: 'prod-eu', error: '403 forbidden' }]);
  });
});

describe('resolveLogSource', () => {
  it('resolves an explicit Graylog id', async () => {
    const r = await resolveLogSource(graylogRegistry(), grafanaRegistry({}), 'gl');
    expect(r.sourceType).toBe('graylog');
  });

  it('resolves an explicit Loki id to its Grafana client and datasource', async () => {
    const r = await resolveLogSource(graylogRegistry(), grafanaRegistry({ 'prod-us': [LOKI] }), 'prod-us/lk1');
    expect(r.sourceType).toBe('loki');
    if (r.sourceType !== 'loki') return;
    expect(r.source.datasourceUid).toBe('lk1');
    expect(r.grafanaUrl).toBe('https://grafana-us.example.com');
  });

  it('refuses an id naming a datasource that is not Loki', async () => {
    await expect(resolveLogSource(graylogRegistry(), grafanaRegistry({ 'prod-us': [PROM] }), 'prod-us/pm1')).rejects.toThrow(/type "prometheus", not "loki"/);
  });

  it('refuses an id naming a datasource that does not exist', async () => {
    await expect(resolveLogSource(graylogRegistry(), grafanaRegistry({ 'prod-us': [LOKI] }), 'prod-us/nope')).rejects.toThrow(/no datasource with uid "nope"/);
  });

  it('refuses an unknown id, listing what exists', async () => {
    await expect(resolveLogSource(graylogRegistry(), grafanaRegistry({ 'prod-us': [LOKI] }), 'bogus')).rejects.toThrow(
      /Unknown log source "bogus". Available: gl \(graylog: Graylog\), prod-us\/lk1 \(loki: Example-Logs\)/,
    );
  });

  it('defaults to the sole Graylog connection when no Grafana connection has Loki', async () => {
    const r = await resolveLogSource(graylogRegistry(), grafanaRegistry({ 'prod-us': [PROM] }), undefined);
    expect(r.source.id).toBe('gl');
  });

  it('defaults to the sole Loki source when there is no Graylog', async () => {
    const r = await resolveLogSource(fakeLogRegistry([], fakeGraylogClient({}).client), grafanaRegistry({ 'prod-us': [LOKI] }), undefined);
    expect(r.source.id).toBe('prod-us/lk1');
  });

  // The failure #265 exists to stop: a service logging to Loki searched in
  // Graylog by default, coming back empty, and reading as "no errors".
  it('refuses to default to Graylog when a Loki source also exists', async () => {
    await expect(resolveLogSource(graylogRegistry(), grafanaRegistry({ 'prod-us': [LOKI] }), undefined)).rejects.toThrow(
      /Could not determine which log source.*gl.*prod-us\/lk1/s,
    );
  });

  it('refuses to default when a Grafana connection could not be checked for Loki', async () => {
    await expect(resolveLogSource(graylogRegistry(), grafanaRegistry({ 'prod-eu': new Error('timeout') }), undefined)).rejects.toThrow(
      /could not be read on Grafana connection\(s\) "prod-eu" \(timeout\)/,
    );
  });

  it('still resolves an explicit Graylog id when a Grafana connection cannot be read', async () => {
    const r = await resolveLogSource(graylogRegistry(), grafanaRegistry({ 'prod-eu': new Error('timeout') }), 'gl');
    expect(r.sourceType).toBe('graylog');
  });

  it('works with no Grafana registry at all (standalone log-only setups and tests)', async () => {
    const r = await resolveLogSource(graylogRegistry(), undefined, undefined);
    expect(r.source.id).toBe('gl');
  });
});

// #279: Grafana only enforces a `/`-free datasource uid from v12, and uids
// created earlier survive an upgrade, so the id can't be split on its last `/`.
describe('resolveLogSource with a "/" in the datasource uid', () => {
  const prod: GrafanaConnection = { id: 'prod', name: 'Prod', url: 'https://grafana.example.com', authType: 'bearer', token: 'p' };
  const prodTeam: GrafanaConnection = { id: 'prod/team', name: 'Prod Team', url: 'https://grafana-team.example.com', authType: 'bearer', token: 't' };
  const TEAM_LOGS: DatasourceInfo = { uid: 'team/logs', id: 3, name: 'Team-Logs', type: 'loki' };
  const noGraylog = () => fakeLogRegistry([], fakeGraylogClient({}).client);

  it('resolves the id list_log_sources gave it, explicitly and as the sole source', async () => {
    const registry = grafanaRegistry({ prod: [TEAM_LOGS] }, [prod]);
    const { sources } = await listLogSources(noGraylog(), registry);
    expect(sources.map((s) => s.id)).toEqual(['prod/team/logs']);

    for (const id of ['prod/team/logs', undefined]) {
      const r = await resolveLogSource(noGraylog(), registry, id);
      expect(r.sourceType).toBe('loki');
      if (r.sourceType !== 'loki') return;
      expect([r.source.grafanaConnection, r.source.datasourceUid]).toEqual(['prod', 'team/logs']);
    }
  });

  it('picks the connection that actually has the datasource when two connection ids prefix the id', async () => {
    const registry = grafanaRegistry({ prod: [LOKI], 'prod/team': [{ ...LOKI, uid: 'logs' }] }, [prod, prodTeam]);
    const r = await resolveLogSource(noGraylog(), registry, 'prod/team/logs');
    expect(r.sourceType === 'loki' && [r.source.grafanaConnection, r.source.datasourceUid]).toEqual(['prod/team', 'logs']);
  });

  it('refuses an id two connections could both mean, naming both', async () => {
    const registry = grafanaRegistry({ prod: [TEAM_LOGS], 'prod/team': [{ ...LOKI, uid: 'logs' }] }, [prod, prodTeam]);
    await expect(resolveLogSource(noGraylog(), registry, 'prod/team/logs')).rejects.toThrow(
      /matches more than one log source.*"prod".*"team\/logs".*"prod\/team".*"logs"/,
    );
  });

  // #279: the Graylog connection used to win silently.
  it('refuses an id that is both a Graylog connection and a Loki source, naming both', async () => {
    const glSlash: LogConnection = { ...graylog, id: 'prod/lk1' };
    const registry = grafanaRegistry({ prod: [LOKI] }, [prod]);
    await expect(resolveLogSource(fakeLogRegistry([glSlash], fakeGraylogClient({}).client), registry, 'prod/lk1')).rejects.toThrow(
      /matches more than one log source.*Graylog connection "prod\/lk1".*"prod".*"lk1"/,
    );
  });

  it('still resolves a Graylog id shaped like a Loki id when no such Loki datasource exists', async () => {
    const glSlash: LogConnection = { ...graylog, id: 'prod/lk1' };
    const registry = grafanaRegistry({ prod: [PROM] }, [prod]);
    const r = await resolveLogSource(fakeLogRegistry([glSlash], fakeGraylogClient({}).client), registry, 'prod/lk1');
    expect(r.sourceType).toBe('graylog');
  });

  // #289 item 1: the unreadable connection might hold a Loki "logs", so the
  // one readable match can't be taken as the answer.
  it('refuses a single Loki match when another prefixing connection could not be read', async () => {
    const registry = grafanaRegistry({ prod: [TEAM_LOGS], 'prod/team': new Error('503 unavailable') }, [prod, prodTeam]);
    await expect(resolveLogSource(noGraylog(), registry, 'prod/team/logs')).rejects.toThrow(
      /Grafana connection "prod"'s Loki datasource "team\/logs".*"prod\/team" \(503 unavailable\).*could not be read/s,
    );
  });

  // #289 item 2: the listing emitted the same id twice with no warning, and
  // the no-connection error said to pass an id that is then refused.
  it('marks ids that name more than one source in the listing', async () => {
    const prodEu: GrafanaConnection = { ...prodTeam, id: 'prod/eu' };
    const registry = grafanaRegistry({ prod: [{ ...LOKI, uid: 'eu/x' }], 'prod/eu': [{ ...LOKI, uid: 'x' }] }, [prod, prodEu]);
    const { sources } = await listLogSources(noGraylog(), registry);
    expect(sources.map((s) => [s.id, s.ambiguousWith])).toEqual([
      ['prod/eu/x', ['Grafana connection "prod/eu"\'s Loki datasource "x"']],
      ['prod/eu/x', ['Grafana connection "prod"\'s Loki datasource "eu/x"']],
    ]);
    const plain = await listLogSources(noGraylog(), grafanaRegistry({ prod: [LOKI] }, [prod]));
    expect(plain.sources[0]).not.toHaveProperty('ambiguousWith');
  });

  it('marks a Graylog id that is also a Loki source id', async () => {
    const glSlash: LogConnection = { ...graylog, id: 'prod/lk1' };
    const { sources } = await listLogSources(fakeLogRegistry([glSlash], fakeGraylogClient({}).client), grafanaRegistry({ prod: [LOKI] }, [prod]));
    expect(sources.map((s) => s.ambiguousWith)).toEqual([['Grafana connection "prod"\'s Loki datasource "lk1"'], ['Graylog connection "prod/lk1"']]);
  });

  it('says in the no-connection error which listed ids cannot be selected', async () => {
    const prodEu: GrafanaConnection = { ...prodTeam, id: 'prod/eu' };
    const registry = grafanaRegistry({ prod: [{ ...LOKI, uid: 'eu/x' }], 'prod/eu': [{ ...LOKI, uid: 'x' }] }, [prod, prodEu]);
    await expect(resolveLogSource(noGraylog(), registry, undefined)).rejects.toThrow(
      /"prod\/eu\/x" names more than one source.*rename/s,
    );
  });

  // #289 item 3: with several candidate splits the per-split reason was dropped.
  it('explains every candidate reading when none of them is a Loki source', async () => {
    const registry = grafanaRegistry({ prod: [{ ...PROM, uid: 'team/logs' }], 'prod/team': [] }, [prod, prodTeam]);
    await expect(resolveLogSource(noGraylog(), registry, 'prod/team/logs')).rejects.toThrow(
      /Grafana connection "prod" has datasource "team\/logs".*type "prometheus", not "loki".*Grafana connection "prod\/team" has no datasource with uid "logs"/s,
    );
  });
});
