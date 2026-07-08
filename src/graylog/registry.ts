import type { Config, LogConnection } from '../config.js';
import { GraylogClient } from './client.js';

/**
 * Same rationale as grafana/registry.ts's ConnectionsSource: either a fixed
 * list (the CLI/env-based path) or a thunk that re-reads the connection
 * store on every call (the Electron app's headless --mcp-server mode), so a
 * log connection added in the connection-manager GUI takes effect on the
 * very next tool call, no server restart needed.
 */
export type LogConnectionsSource = LogConnection[] | (() => LogConnection[]);

/**
 * Lazily builds and caches one GraylogClient per configured log connection —
 * same lazy-cache-per-id behavior as grafana/registry.ts's ConnectionRegistry,
 * kept as a separate class rather than a shared generic since GraylogClient
 * and GrafanaClient have unrelated constructors and no other code needs both.
 */
export class LogConnectionRegistry {
  private readonly clients = new Map<string, GraylogClient>();
  private readonly builtFrom = new Map<string, LogConnection>();

  constructor(
    private readonly source: LogConnectionsSource,
    private readonly config: Config,
  ) {}

  list(): LogConnection[] {
    return typeof this.source === 'function' ? this.source() : this.source;
  }

  get(id: string): GraylogClient {
    const connection = this.list().find((c) => c.id === id);
    if (!connection) {
      throw new Error(`Unknown log connection "${id}"`);
    }
    const cached = this.clients.get(id);
    const builtFrom = this.builtFrom.get(id);
    if (cached && builtFrom && JSON.stringify(builtFrom) === JSON.stringify(connection)) {
      return cached;
    }
    const client = new GraylogClient(connection, this.config);
    this.clients.set(id, client);
    this.builtFrom.set(id, connection);
    return client;
  }
}
