import type { Config, LogConnection } from '../config.js';
import { GraylogClient } from './client.js';

/**
 * Same rationale as grafana/registry.ts's ConnectionsSource: either a fixed
 * list (standalone CLI/env-based path) or a thunk that re-reads the
 * connection store on every call (Electron's --mcp-server mode), so a log
 * connection added/edited in the GUI takes effect on the next tool call with
 * no server restart. May return a Promise for the same reason the Grafana
 * thunk may (safeStorage's async-only decrypt), so list()/get() are async.
 */
export type LogConnectionsSource = LogConnection[] | (() => LogConnection[] | Promise<LogConnection[]>);

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

  async list(): Promise<LogConnection[]> {
    return typeof this.source === 'function' ? await this.source() : this.source;
  }

  /**
   * The client for `id` together with the connection it was built from, from
   * one read of the source — see grafana/registry.ts's resolve() for why
   * display fields must come from the same read as the client.
   */
  async resolve(id: string): Promise<{ client: GraylogClient; connection: LogConnection }> {
    const connection = (await this.list()).find((c) => c.id === id);
    if (!connection) {
      throw new Error(`Unknown log connection "${id}"`);
    }
    const cached = this.clients.get(id);
    const builtFrom = this.builtFrom.get(id);
    if (cached && builtFrom && JSON.stringify(builtFrom) === JSON.stringify(connection)) {
      return { client: cached, connection };
    }
    const client = new GraylogClient(connection, this.config);
    this.clients.set(id, client);
    this.builtFrom.set(id, connection);
    return { client, connection };
  }

  async get(id: string): Promise<GraylogClient> {
    return (await this.resolve(id)).client;
  }
}
