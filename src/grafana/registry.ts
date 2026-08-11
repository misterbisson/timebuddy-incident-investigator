import type { Config, GrafanaConnection } from '../config.js';
import { hostMatchesConnection } from '../connections/resolve.js';
import { GrafanaClient } from './client.js';

/**
 * Either a fixed list (the CLI/env-based path, where there's no live store to
 * re-read) or a thunk that re-reads the connection store on every call (the
 * Electron app's headless --mcp-server mode, backed by connections.json) —
 * a static array baked in at process-startup means adding a connection in
 * the connection-manager GUI later has no effect until the whole MCP server
 * process is respawned, which isn't something restarting just the GUI
 * window actually does.
 */
export type ConnectionsSource = GrafanaConnection[] | (() => GrafanaConnection[]);

/**
 * Lazily builds and caches one GrafanaClient per configured connection, so a
 * session that only ever touches one connection never opens clients (and
 * their per-connection semaphores) for the others. Re-resolves the
 * connections source on every list()/get() call — cheap for a static array,
 * and for the Electron thunk means a newly added/edited connection is picked
 * up on the very next tool call, with no server restart required. A cached
 * client is rebuilt only when that connection's config actually changed
 * (e.g. a rotated token), not on every call.
 */
export class ConnectionRegistry {
  private readonly clients = new Map<string, GrafanaClient>();
  private readonly builtFrom = new Map<string, GrafanaConnection>();

  constructor(
    private readonly source: ConnectionsSource,
    private readonly config: Config,
  ) {}

  list(): GrafanaConnection[] {
    return typeof this.source === 'function' ? this.source() : this.source;
  }

  get(id: string): GrafanaClient {
    const connection = this.list().find((c) => c.id === id);
    if (!connection) {
      throw new Error(`Unknown Grafana connection "${id}"`);
    }
    const cached = this.clients.get(id);
    const builtFrom = this.builtFrom.get(id);
    if (cached && builtFrom && JSON.stringify(builtFrom) === JSON.stringify(connection)) {
      return cached;
    }
    const client = new GrafanaClient(connection, this.config);
    this.clients.set(id, client);
    this.builtFrom.set(id, connection);
    return client;
  }

  /**
   * Which datasource types (if any) this connection is authorized to run
   * model-authored queries against — see config.ts's AdhocQueryPolicy for where
   * that authorization comes from and why it's workspace-scoped rather than
   * stored per connection.
   *
   * Matching goes through hostMatchesConnection, the same matcher that maps an
   * inbound alert link's hostname to a connection, so a policy naming a
   * `matchHosts` alias authorizes the connection that alias belongs to. That's
   * deliberate: the alternative is naming connections by their
   * `crypto.randomUUID()` id in a checked-in `.mcp.json`, which is unreadable
   * and changes per install.
   *
   * Returns an empty array for "not authorized", never undefined, so a caller
   * can't accidentally treat a missing policy as permissive. Types from multiple
   * matching policies are unioned — two flags naming the same host by different
   * aliases should add up rather than one silently winning.
   */
  /**
   * Policy hosts that match no configured connection — the most likely
   * `.mcp.json` typo (wrong hostname, or a connection that hasn't been added
   * yet). Without this, such a policy still registers the tool (the gate only
   * asks whether *any* policy exists) and then fails every call with "not
   * authorized for ad-hoc queries", which reads like a bug in the feature rather
   * than a typo in one line of config. Callers report it at startup, while
   * someone is still looking at the terminal and can fix it.
   *
   * Deliberately a warning rather than a registration veto: connections are
   * re-read from the store on every tool call, so a host that matches nothing
   * at startup may match once someone adds that connection in the GUI. Refusing
   * to register would turn a recoverable state into one needing a restart, for
   * no safety gain — an unmatched policy authorizes nothing either way.
   */
  unmatchedAdhocHosts(): string[] {
    const connections = this.list();
    return (this.config.adhocQueries ?? [])
      .map((policy) => policy.host)
      .filter((host) => !connections.some((connection) => hostMatchesConnection(host, connection)));
  }

  adhocDatasourceTypes(connectionId: string): string[] {
    const connection = this.list().find((c) => c.id === connectionId);
    if (!connection) return [];
    const types = new Set<string>();
    for (const policy of this.config.adhocQueries ?? []) {
      if (hostMatchesConnection(policy.host, connection)) {
        for (const type of policy.datasourceTypes) types.add(type.toLowerCase());
      }
    }
    return [...types];
  }
}
