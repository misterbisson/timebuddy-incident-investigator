import type { Config, LogConnection } from '../config.js';
import { GraylogClient } from './client.js';

/**
 * Same rationale as grafana/registry.ts's ConnectionsSource: either a fixed
 * list (standalone CLI/env-based path) or a thunk that re-reads the
 * connection store on every call (Electron's --mcp-server mode), so a log
 * connection added/edited in the GUI takes effect on the next tool call with
 * no server restart.
 */
export type LogConnectionsSource = LogConnection[] | (() => LogConnection[]);

/**
 * Log-connection counterpart to grafana/registry.ts's ConnectionRegistry —
 * same lazy-build-and-cache-per-id behavior, kept as its own class (rather
 * than a shared generic) since the two connection kinds have little in
 * common beyond this caching shape.
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
