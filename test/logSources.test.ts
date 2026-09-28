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
