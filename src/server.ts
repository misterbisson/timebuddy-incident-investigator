import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Config, GrafanaConnection, LogConnection } from './config.js';
import { loadConfig } from './config.js';
import { ConnectionRegistry, type ConnectionsSource } from './grafana/registry.js';
import { LogConnectionRegistry, type LogConnectionsSource } from './graylog/registry.js';
import type { Screenshotter } from './screenshot/types.js';
import type { ActivityLog } from './activity/activityLog.js';
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
 * and startup logging. `logSource` is the same shape for Graylog connections
 * and defaults to empty — unlike Grafana, zero log connections configured is
 * a valid, common state (log search is optional), so it's never a startup
 * guard, only something resolveConnection reports if a log tool is actually
 * called with none configured.
 */
export function createServer(
  source: ConnectionsSource,
  configOverrides: Partial<Config> = {},
  screenshotter?: Screenshotter,
  activityLog?: ActivityLog,
  logSource: LogConnectionsSource = [],
): McpServer {
  const startupSnapshot = typeof source === 'function' ? source() : source;
  if (startupSnapshot.length === 0) {
    throw new Error(
      'No Grafana connections configured. Set GRAFANA_URL/GRAFANA_TOKEN, or add connections in the ' +
        'connection manager app (see README).',
    );
  }
  const logStartupSnapshot = typeof logSource === 'function' ? logSource() : logSource;

  const config: Config = {
    ...loadConfig(),
    ...configOverrides,
    connections: startupSnapshot,
    logConnections: logStartupSnapshot,
  };
  const registry = new ConnectionRegistry(source, config);
  const logRegistry = new LogConnectionRegistry(logSource, config);

  const server = new McpServer({
    name: 'timebuddy-incident-investigator',
    version: '0.1.0',
  });

  registerAllTools(server, { registry, logRegistry, config, screenshotter, activityLog });
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
  screenshotter?: Screenshotter,
  activityLog?: ActivityLog,
  logSource: LogConnectionsSource = [],
): Promise<McpServer> {
  const server = createServer(source, configOverrides, screenshotter, activityLog, logSource);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

export type { Config, GrafanaConnection, LogConnection } from './config.js';
export type { ConnectionsSource } from './grafana/registry.js';
export type { LogConnectionsSource } from './graylog/registry.js';
export type { Screenshotter, CapturePanelRequest } from './screenshot/types.js';
export { createActivityLog } from './activity/activityLog.js';
export type { ActivityLog, ActivityEntry } from './activity/activityLog.js';
export { buildAuthHeader } from './grafana/client.js';
export { buildGraylogAuthHeader } from './graylog/client.js';
