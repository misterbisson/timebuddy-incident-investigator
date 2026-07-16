import { loadConfig } from './config.js';
import { startMcpServer } from './server.js';

/**
 * Standalone CLI entrypoint (`npm run dev` / `node dist/index.js`) — reads
 * connections from GRAFANA_URL/GRAFANA_TOKEN only. This is for local
 * development and CI; the distributed app runs through the Electron
 * connection manager's `--mcp-server` mode instead (electron/src/main.js),
 * which supplies connections from its own store and calls startMcpServer()
 * directly rather than going through this file.
 */
async function main() {
  const config = loadConfig();
  await startMcpServer(config.connections, config, undefined, undefined, config.logConnections);
  console.error(
    `timebuddy-incident-investigator MCP server running on stdio (${config.connections.length} Grafana connection(s): ${config.connections.map((c) => c.id).join(', ')}` +
      `; ${config.logConnections.length} log connection(s): ${config.logConnections.map((c) => c.id).join(', ')})`,
  );
}

main().catch((err) => {
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
