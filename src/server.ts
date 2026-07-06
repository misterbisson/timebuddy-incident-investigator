import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Config, GrafanaConnection } from './config.js';
import { loadConfig } from './config.js';
import { ConnectionRegistry } from './grafana/registry.js';
import { registerAllTools } from './tools/registerAll.js';

/**
 * Builds the MCP server and registers every tool against the given
 * connections, but does not connect a transport — callers decide how the
 * server talks to its client (stdio for the CLI entrypoint in index.ts, or
 * whatever transport an embedding app like the Electron connection manager
 * chooses).
 */
export function createServer(connections: GrafanaConnection[], configOverrides: Partial<Config> = {}): McpServer {
  if (connections.length === 0) {
    throw new Error(
      'No Grafana connections configured. Set GRAFANA_URL/GRAFANA_TOKEN, or add connections in the ' +
        'connection manager app (see README).',
    );
  }

  const config: Config = { ...loadConfig(), ...configOverrides, connections };
  const registry = new ConnectionRegistry(connections, config);

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
  connections: GrafanaConnection[],
  configOverrides: Partial<Config> = {},
): Promise<McpServer> {
  const server = createServer(connections, configOverrides);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

export type { Config, GrafanaConnection } from './config.js';
