import type { GrafanaConnection, LogConnection } from '../config.js';
import type { GrafanaClient } from '../grafana/client.js';
import type { ConnectionRegistry } from '../grafana/registry.js';
import type { GraylogClient } from '../graylog/client.js';
import type { LogConnectionRegistry } from '../graylog/registry.js';

/**
 * The log tools' view of "a place logs can be searched" (issue #265): either a
 * configured Graylog connection, or a `loki` datasource reached through a
 * Grafana connection this server already holds.
 *
 * Loki is deliberately not a new kind of LogConnection. It has no web UI or
 * credential of its own that users hold — Grafana is how people reach it — so
 * a Loki source is *derived* from the Grafana connections on every call rather
 * than configured, and a datasource added in Grafana is searchable on the next
 * call with nothing to set up. The cost is that listing sources is no longer
 * free: it reads each Grafana connection's datasource list (memoized per
 * client), and that read can fail, which the resolution rules below have to
 * account for rather than paper over.
 */

export interface GraylogLogSource {
  sourceType: 'graylog';
  id: string;
  name: string;
  tags?: string[];
  streamId?: string;
  streamName?: string;
}

export interface LokiLogSource {
  sourceType: 'loki';
  /** `<grafanaConnectionId>/<datasourceUid>` — see lokiSourceId. */
  id: string;
  /** The datasource's name in Grafana. */
  name: string;
  /** The Grafana connection's tags: a Loki source covers whatever environment its Grafana does. */
  tags?: string[];
  grafanaConnection: string;
  datasourceUid: string;
}

export type LogSource = GraylogLogSource | LokiLogSource;

/** A Grafana connection whose datasources couldn't be listed — so a Loki source there can't be ruled out. */
export interface LokiDiscoveryProblem {
  connection: string;
  error: string;
}

/**
 * A Loki source's id. `/` as the separator because a Grafana datasource uid
 * can't contain one (uids are letters, digits, `-` and `_`), so the *last* `/`
 * always splits it back apart even if a connection id happens to contain one.
 */
export function lokiSourceId(grafanaConnectionId: string, datasourceUid: string): string {
  return `${grafanaConnectionId}/${datasourceUid}`;
}

function graylogSource(c: LogConnection): GraylogLogSource {
  return {
    sourceType: 'graylog',
    id: c.id,
    name: c.name,
    ...(c.tags ? { tags: c.tags } : {}),
    ...(c.streamId ? { streamId: c.streamId } : {}),
    ...(c.streamName ? { streamName: c.streamName } : {}),
  };
}

function lokiSource(connection: GrafanaConnection, datasource: { uid: string; name: string }): LokiLogSource {
  return {
    sourceType: 'loki',
    id: lokiSourceId(connection.id, datasource.uid),
    name: datasource.name,
    ...(connection.tags ? { tags: connection.tags } : {}),
    grafanaConnection: connection.id,
    datasourceUid: datasource.uid,
  };
}

/** Every Loki datasource on every Grafana connection, plus the connections that couldn't be read. */
export async function listLokiSources(
  registry: ConnectionRegistry | undefined,
): Promise<{ sources: LokiLogSource[]; problems: LokiDiscoveryProblem[] }> {
  const connections = registry?.list() ?? [];
  const settled = await Promise.allSettled(
    connections.map(async (connection) => {
      const datasources = await registry!.get(connection.id).listDatasources();
      return datasources.filter((d) => d.type.toLowerCase() === 'loki').map((d) => lokiSource(connection, d));
    }),
  );
  const sources: LokiLogSource[] = [];
  const problems: LokiDiscoveryProblem[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') sources.push(...outcome.value);
    else {
      const err = outcome.reason;
      problems.push({ connection: connections[i]!.id, error: err instanceof Error ? err.message : String(err) });
    }
  });
  return { sources, problems };
}

export async function listLogSources(
  logRegistry: LogConnectionRegistry | undefined,
  registry: ConnectionRegistry | undefined,
): Promise<{ sources: LogSource[]; problems: LokiDiscoveryProblem[] }> {
  const graylog = (logRegistry?.list() ?? []).map(graylogSource);
  const loki = await listLokiSources(registry);
  return { sources: [...graylog, ...loki.sources], problems: loki.problems };
}

export type ResolvedLogSource =
  | { sourceType: 'graylog'; source: GraylogLogSource; client: GraylogClient }
  | { sourceType: 'loki'; source: LokiLogSource; client: GrafanaClient; grafanaUrl: string; grafanaName: string };

function describe(sources: LogSource[]): string {
  return sources.map((s) => `${s.id} (${s.sourceType}: ${s.name})`).join(', ') || 'none';
}

/**
 * Picks the log source a search_logs / correlate_logs call runs against.
 *
 * Same rules as connections/resolve.ts's resolveConnection — an explicit id
 * wins, otherwise the sole source, otherwise a hard error listing the ids —
 * with one addition forced by Loki sources being discovered rather than
 * configured: **a Grafana connection whose datasources can't be listed blocks
 * the sole-source fallback.** That connection might hold a Loki datasource, so
 * "only one source" can't be established, and defaulting to the one Graylog
 * connection anyway is exactly the failure this whole change exists to stop: a
 * service that logs to Loki gets searched in Graylog, comes back empty, and
 * reads as "no errors". Passing an id explicitly never needs the listing.
 */
export async function resolveLogSource(
  logRegistry: LogConnectionRegistry | undefined,
  registry: ConnectionRegistry | undefined,
  explicitId: string | undefined,
): Promise<ResolvedLogSource> {
  const graylogConnections = logRegistry?.list() ?? [];

  if (explicitId) {
    const graylog = graylogConnections.find((c) => c.id === explicitId);
    if (graylog) {
      return { sourceType: 'graylog', source: graylogSource(graylog), client: logRegistry!.get(graylog.id) };
    }
    const sep = explicitId.lastIndexOf('/');
    const grafana = sep > 0 ? registry?.list().find((c) => c.id === explicitId.slice(0, sep)) : undefined;
    if (grafana) {
      const uid = explicitId.slice(sep + 1);
      const client = registry!.get(grafana.id);
      const datasources = await client.listDatasources();
      const found = datasources.find((d) => d.uid === uid);
      if (!found) {
        throw new Error(
          `Grafana connection "${grafana.id}" has no datasource with uid "${uid}". Call list_log_sources to see ` +
            'the log sources that exist.',
        );
      }
      if (found.type.toLowerCase() !== 'loki') {
        throw new Error(
          `Datasource "${found.name}" on "${grafana.id}" is type "${found.type}", not "loki" — only Loki datasources ` +
            'are log sources. Call list_log_sources to see the log sources that exist.',
        );
      }
      return {
        sourceType: 'loki',
        source: lokiSource(grafana, found),
        client,
        grafanaUrl: grafana.url,
        grafanaName: grafana.name,
      };
    }
    const { sources } = await listLogSources(logRegistry, registry).catch(() => ({ sources: [] as LogSource[] }));
    throw new Error(`Unknown log source "${explicitId}". Available: ${describe(sources)}.`);
  }

  const { sources, problems } = await listLogSources(logRegistry, registry);
  if (problems.length > 0) {
    throw new Error(
      'Could not determine which log source to use: the datasource list could not be read on Grafana ' +
        `connection(s) ${problems.map((p) => `"${p.connection}" (${p.error})`).join(', ')}, so a Loki source there ` +
        `can't be ruled out. Known sources: ${describe(sources)}. Pass "connection" explicitly.`,
    );
  }
  if (sources.length === 0) {
    throw new Error(
      'No log sources available: no Graylog connection is configured (GRAYLOG_URL/GRAYLOG_TOKEN, or the ' +
        'connection manager app) and no Grafana connection has a Loki datasource.',
    );
  }
  if (sources.length > 1) {
    throw new Error(`Could not determine which log source to use. Available: ${describe(sources)}. Pass "connection" explicitly.`);
  }
  // Exactly one: re-enter the explicit path so there is one construction of each kind.
  return resolveLogSource(logRegistry, registry, sources[0]!.id);
}
