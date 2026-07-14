import type { Config, GrafanaConnection } from '../config.js';
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
}
