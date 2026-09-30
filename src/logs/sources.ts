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
  /** See LokiLogSource.ambiguousWith. */
  ambiguousWith?: string[];
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
  /**
   * Set only when another listed source has the same id, naming each of them.
   * Resolution refuses an id with two meanings, so neither can be selected
   * until one of the connections is renamed.
   */
  ambiguousWith?: string[];
}

export type LogSource = GraylogLogSource | LokiLogSource;

/** A Grafana connection whose datasources couldn't be listed — so a Loki source there can't be ruled out. */
export interface LokiDiscoveryProblem {
  connection: string;
  error: string;
}

/**
 * A Loki source's id: `<grafanaConnectionId>/<datasourceUid>`.
 *
 * Either half can contain a `/`, so the id is never split on one. Grafana only
 * enforces a `/`-free uid from v12 (11.1 warns, 11.2 adds an opt-in check),
 * and a uid created earlier survives the upgrade. resolveLogSource instead
 * matches the id against the known connection ids — the half this server
 * controls — and takes everything after that prefix as the uid.
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
  return { sources: markAmbiguous([...graylog, ...loki.sources]), problems: loki.problems };
}

export type ResolvedLogSource =
  | { sourceType: 'graylog'; source: GraylogLogSource; client: GraylogClient }
  | { sourceType: 'loki'; source: LokiLogSource; client: GrafanaClient; grafanaUrl: string; grafanaName: string };

/** How a refusal or `ambiguousWith` names one reading of an id. */
function meaningOf(source: LogSource): string {
  return source.sourceType === 'graylog'
    ? `Graylog connection "${source.id}"`
    : `Grafana connection "${source.grafanaConnection}"'s Loki datasource "${source.datasourceUid}"`;
}

/** Sets ambiguousWith on every source whose id another source also has. */
function markAmbiguous(sources: LogSource[]): LogSource[] {
  const byId = new Map<string, LogSource[]>();
  for (const s of sources) byId.set(s.id, [...(byId.get(s.id) ?? []), s]);
  return sources.map((s) => {
    const others = byId.get(s.id)!.filter((o) => o !== s);
    return others.length > 0 ? { ...s, ambiguousWith: others.map(meaningOf) } : s;
  });
}

function describe(sources: LogSource[]): string {
  return sources.map((s) => `${s.id} (${s.sourceType}: ${s.name})`).join(', ') || 'none';
}

/** One way to read a Loki source id: this Grafana connection, and the uid left after its id and a `/`. */
interface LokiIdSplit {
  grafana: GrafanaConnection;
  uid: string;
}

/** Every Grafana connection whose id, followed by `/`, begins `id` — see lokiSourceId for why not a split on `/`. */
function lokiIdSplits(registry: ConnectionRegistry | undefined, id: string): LokiIdSplit[] {
  return (registry?.list() ?? [])
    .filter((c) => id.length > c.id.length + 1 && id.startsWith(`${c.id}/`))
    .map((c) => ({ grafana: c, uid: id.slice(c.id.length + 1) }));
}

interface LokiProbe extends LokiIdSplit {
  outcome: 'loki' | 'not-loki' | 'missing' | 'unreadable';
  datasource?: { uid: string; name: string };
  type?: string;
  error?: string;
  cause?: unknown;
}

/** What `split.uid` is on `split.grafana`, if anything. */
async function probeLokiSplit(registry: ConnectionRegistry, split: LokiIdSplit): Promise<LokiProbe> {
  let datasources;
  try {
    datasources = await registry.get(split.grafana.id).listDatasources();
  } catch (err) {
    return { ...split, outcome: 'unreadable', error: err instanceof Error ? err.message : String(err), cause: err };
  }
  const found = datasources.find((d) => d.uid === split.uid);
  if (!found) return { ...split, outcome: 'missing' };
  return { ...split, outcome: found.type.toLowerCase() === 'loki' ? 'loki' : 'not-loki', datasource: found, type: found.type };
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
 * reads as "no errors".
 *
 * An explicit id is matched as a Graylog connection id and as
 * `<grafanaConnectionId>/<uid>` for every Grafana connection whose id prefixes
 * it (see lokiSourceId). More than one match is refused, naming each, rather
 * than resolved to whichever is checked first.
 */
export async function resolveLogSource(
  logRegistry: LogConnectionRegistry | undefined,
  registry: ConnectionRegistry | undefined,
  explicitId: string | undefined,
): Promise<ResolvedLogSource> {
  const graylogConnections = logRegistry?.list() ?? [];

  if (explicitId) {
    const graylog = graylogConnections.find((c) => c.id === explicitId);
    const splits = lokiIdSplits(registry, explicitId);
    if (graylog && splits.length === 0) {
      return { sourceType: 'graylog', source: graylogSource(graylog), client: logRegistry!.get(graylog.id) };
    }

    const probes = await Promise.all(splits.map((split) => probeLokiSplit(registry!, split)));
    const matches = probes.filter((p): p is LokiProbe & { datasource: { uid: string; name: string } } => p.outcome === 'loki');
    const unreadable = probes.filter((p) => p.outcome === 'unreadable');

    // Two things this id could mean is a hard error, never a pick.
    const meanings = [
      ...(graylog ? [`Graylog connection "${graylog.id}"`] : []),
      ...matches.map((m) => `Grafana connection "${m.grafana.id}"'s Loki datasource "${m.uid}"`),
    ];
    if (meanings.length > 1) {
      throw new Error(
        `Log source id "${explicitId}" matches more than one log source: ${meanings.join(', ')}. Rename one of ` +
          'those connections so its id no longer overlaps the other.',
      );
    }
    // One reading found, but an unreadable connection might hold another, so
    // the one found can't be taken as the answer.
    if (meanings.length === 1 && unreadable.length > 0) {
      throw new Error(
        `Log source id "${explicitId}" matches ${meanings[0]}, but could also be a Loki datasource on Grafana ` +
          `connection(s) ${unreadable.map((u) => `"${u.grafana.id}" (${u.error})`).join(', ')}, whose datasources ` +
          'could not be read, so which one it means can\'t be settled. Retry once that connection is reachable, or ' +
          'rename one of the connections.',
      );
    }
    if (graylog) {
      return { sourceType: 'graylog', source: graylogSource(graylog), client: logRegistry!.get(graylog.id) };
    }
    if (matches.length === 1) {
      const { grafana, datasource } = matches[0]!;
      return {
        sourceType: 'loki',
        source: lokiSource(grafana, datasource),
        client: registry!.get(grafana.id),
        grafanaUrl: grafana.url,
        grafanaName: grafana.name,
      };
    }
    // Nothing matched. With one candidate split, say exactly why it didn't.
    if (probes.length === 1) {
      const [probe] = probes as [LokiProbe];
      if (probe.outcome === 'unreadable') throw probe.cause;
      if (probe.outcome === 'not-loki') {
        throw new Error(
          `Datasource "${probe.datasource!.name}" on "${probe.grafana.id}" is type "${probe.type}", not "loki" — only ` +
            'Loki datasources are log sources. Call list_log_sources to see the log sources that exist.',
        );
      }
      throw new Error(
        `Grafana connection "${probe.grafana.id}" has no datasource with uid "${probe.uid}". Call list_log_sources ` +
          'to see the log sources that exist.',
      );
    }
    const { sources } = await listLogSources(logRegistry, registry).catch(() => ({ sources: [] as LogSource[] }));
    const reasons = probes.map((p) => {
      if (p.outcome === 'unreadable') return `Grafana connection "${p.grafana.id}"'s datasources could not be read (${p.error})`;
      if (p.outcome === 'not-loki') {
        return `Grafana connection "${p.grafana.id}" has datasource "${p.uid}" (${p.datasource!.name}), but it is type "${p.type}", not "loki"`;
      }
      return `Grafana connection "${p.grafana.id}" has no datasource with uid "${p.uid}"`;
    });
    throw new Error(
      `Unknown log source "${explicitId}"${reasons.length > 0 ? `: ${reasons.join('; ')}` : ''}. Available: ${describe(sources)}.`,
    );
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
    const ambiguousIds = [...new Set(sources.filter((s) => s.ambiguousWith).map((s) => s.id))];
    const note =
      ambiguousIds.length > 0
        ? ` Note that ${ambiguousIds.map((id) => `"${id}"`).join(', ')} names more than one source and can't be ` +
          'selected until one of those connections is renamed to a non-overlapping id.'
        : '';
    throw new Error(
      `Could not determine which log source to use. Available: ${describe(sources)}. Pass "connection" explicitly.${note}`,
    );
  }
  // Exactly one: re-enter the explicit path so there is one construction of each kind.
  return resolveLogSource(logRegistry, registry, sources[0]!.id);
}
