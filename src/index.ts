import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { loadConnectionsFromDisk } from './connections/store.js';
import { ConnectionRegistry } from './grafana/registry.js';
import { registerAllTools } from './tools/registerAll.js';

async function main() {
  const config = loadConfig();
  const diskConnections = await loadConnectionsFromDisk(config);
  const seenIds = new Set(config.connections.map((c) => c.id));
  config.connections = [...config.connections, ...diskConnections.filter((c) => !seenIds.has(c.id))];

  if (config.connections.length === 0) {
    throw new Error(
      'No Grafana connections configured. Set GRAFANA_URL/GRAFANA_TOKEN, or run the connection manager app ' +
        'and point GRAFANA_CONNECTIONS_DIR at its storage location (see README).',
    );
  }

  const registry = new ConnectionRegistry(config.connections, config);

  const server = new McpServer({
    name: 'timebuddy-incident-investigator',
    version: '0.1.0',
  });

  registerAllTools(server, { registry, config });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `timebuddy-incident-investigator MCP server running on stdio (${config.connections.length} Grafana connection(s): ${config.connections.map((c) => c.id).join(', ')})`,
  );
}

main().catch((err) => {
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
