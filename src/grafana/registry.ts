import type { Config, GrafanaConnection } from '../config.js';
import { GrafanaClient } from './client.js';

/**
 * Lazily builds and caches one GrafanaClient per configured connection, so a
 * session that only ever touches one connection never opens clients (and
 * their per-connection semaphores) for the others.
 */
export class ConnectionRegistry {
  private readonly clients = new Map<string, GrafanaClient>();

  constructor(
    private readonly connections: GrafanaConnection[],
    private readonly config: Config,
  ) {}

  list(): GrafanaConnection[] {
    return this.connections;
  }

  get(id: string): GrafanaClient {
    let client = this.clients.get(id);
    if (client) return client;
    const connection = this.connections.find((c) => c.id === id);
    if (!connection) {
      throw new Error(`Unknown Grafana connection "${id}"`);
    }
    client = new GrafanaClient(connection, this.config);
    this.clients.set(id, client);
    return client;
  }
}
