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

  private snapshot: LogConnection[];

  constructor(
    private readonly source: LogConnectionsSource,
    private readonly config: Config,
  ) {
    this.snapshot = typeof source === 'function' ? [] : source;
  }

  async list(): Promise<LogConnection[]> {
    const connections = typeof this.source === 'function' ? await this.source() : this.source;
    this.snapshot = connections;
    return connections;
  }

  /**
   * The result of the most recent list() — synchronously, without re-reading
   * the source. Only for non-secret display metadata (url, name, stream) of a
   * connection the current tool call has already resolved through list() or
   * get(): the URL builders and Activity-log helpers in tools/shared.ts, which
   * run inside .map() callbacks and catch blocks where an await would mean
   * restructuring every result builder around Promise.all.
   *
   * Never use it to *choose* a connection or build a client — that must go
   * through list()/get(), which re-read the source so a GUI edit takes effect
   * on the next tool call. Empty until the first list() for a thunk source;
   * callers already treat a missing connection as "no URL", never an error.
   */
  lastListed(): LogConnection[] {
    return this.snapshot;
  }

  async get(id: string): Promise<GraylogClient> {
    const connection = (await this.list()).find((c) => c.id === id);
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
