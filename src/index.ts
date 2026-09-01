import { loadConfig, parseAdhocQueryFlags } from './config.js';
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
  // Same per-workspace ad-hoc-query authorization the Electron binary honors
  // (see config.ts's AdhocQueryPolicy). Parsed here too rather than only there:
  // parseAdhocQueryFlags is exported public API, so a flag passed to this
  // entrypoint that silently did nothing — no tool, no explanation — would be
  // exactly the trap the `problems` list exists to prevent.
  const { policies: adhocQueries, problems: adhocProblems } = parseAdhocQueryFlags(process.argv);
  for (const problem of adhocProblems) {
    console.error(`Ignoring ad-hoc query flag: ${problem}`);
  }
  await startMcpServer(
    config.connections,
    { ...config, adhocQueries },
    undefined,
    undefined,
    config.logConnections,
  );
  console.error(
    `timebuddy-incident-investigator MCP server running on stdio (${config.connections.length} Grafana connection(s): ${config.connections.map((c) => c.id).join(', ')}` +
      `; ${config.logConnections.length} log connection(s): ${config.logConnections.map((c) => c.id).join(', ')})` +
      // Logged loudly when on, silent when off — this is the one flag that
      // widens what the agent may run, so its state belongs in the startup line
      // someone checks when a session behaves unexpectedly.
      (adhocQueries.length > 0
        ? `; ad-hoc queries ENABLED for ${adhocQueries.map((p) => `${p.host} (${p.datasourceTypes.join('/')})`).join(', ')}`
        : ''),
  );
}

main().catch((err) => {
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
