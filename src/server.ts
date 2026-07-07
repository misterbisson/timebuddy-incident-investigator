import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Config, GrafanaConnection } from './config.js';
import { loadConfig } from './config.js';
import { ConnectionRegistry, type ConnectionsSource } from './grafana/registry.js';
import { registerAllTools } from './tools/registerAll.js';

/**
 * Builds the MCP server and registers every tool against the given
 * connections, but does not connect a transport — callers decide how the
 * server talks to its client (stdio for the CLI entrypoint in index.ts, or
 * whatever transport an embedding app like the Electron connection manager
 * chooses). `source` may be a thunk (see ConnectionsSource) so the registry
 * re-reads the live connection store on every tool call rather than freezing
 * whatever was configured at process startup — `config.connections` itself
 * stays a plain startup snapshot, only used for the zero-connections guard
 * and startup logging.
 */
export function createServer(source: ConnectionsSource, configOverrides: Partial<Config> = {}): McpServer {
  const startupSnapshot = typeof source === 'function' ? source() : source;
  if (startupSnapshot.length === 0) {
    throw new Error(
      'No Grafana connections configured. Set GRAFANA_URL/GRAFANA_TOKEN, or add connections in the ' +
        'connection manager app (see README).',
    );
  }

  const config: Config = { ...loadConfig(), ...configOverrides, connections: startupSnapshot };
  const registry = new ConnectionRegistry(source, config);

  const server = new McpServer({
    name: 'timebuddy-incident-investigator',
    version: '0.1.0',
  });

  registerAllTools(server, { registry, config });
  return server;
}

/**
 * Builds the server and connects it over stdio — the shape both the CLI
 * entrypoint (index.ts) and the Electron app's headless `--mcp-server` mode
 * need, since both are just "whatever spawned this process talks MCP over
 * our stdio."
 */
export async function startMcpServer(
  source: ConnectionsSource,
  configOverrides: Partial<Config> = {},
): Promise<McpServer> {
  const server = createServer(source, configOverrides);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

export type { Config, GrafanaConnection } from './config.js';
export type { ConnectionsSource } from './grafana/registry.js';
