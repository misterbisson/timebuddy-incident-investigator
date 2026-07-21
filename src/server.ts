import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Config, GrafanaConnection } from './config.js';
import { loadConfig } from './config.js';
import { ConnectionRegistry, type ConnectionsSource } from './grafana/registry.js';
import type { Screenshotter } from './screenshot/types.js';
import type { ActivityLog } from './activity/activityLog.js';
import { registerAllTools } from './tools/registerAll.js';
import { runStartupMaintenance } from './security/retention.js';

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
export function createServer(
  source: ConnectionsSource,
  configOverrides: Partial<Config> = {},
  screenshotter?: Screenshotter,
  activityLog?: ActivityLog,
): McpServer {
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
    // Kept in step with package.json by release-please. The trailing comment
    // is load-bearing, not decoration: it's the marker release-please's
    // generic updater looks for, and a .ts file can't take the `jsonpath`
    // entry the JSON artifacts use. This string is what the server reports to
    // Claude Code/Desktop in the initialize handshake, so if it stops being
    // updated it misreports the running version to every client, forever.
    version: '0.1.0', // x-release-please-version
  });

  registerAllTools(server, { registry, config, screenshotter, activityLog });
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
): Promise<McpServer> {
  const server = createServer(source, configOverrides, screenshotter, activityLog);

  // Bound the local data dir's disk footprint once per process start. Kept off
  // the createServer() construction path (which unit tests exercise heavily and
  // shouldn't do filesystem cleanup as a side effect) and fired-and-forgotten
  // here: it's best-effort and never throws, so it must not delay or block the
  // server coming up on stdio.
  const config: Config = { ...loadConfig(), ...configOverrides };
  void runStartupMaintenance(config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

export type { Config, GrafanaConnection } from './config.js';
export type { ConnectionsSource } from './grafana/registry.js';
export type { Screenshotter, CapturePanelRequest } from './screenshot/types.js';
export { createActivityLog } from './activity/activityLog.js';
export type { ActivityLog, ActivityEntry } from './activity/activityLog.js';
export { buildAuthHeader } from './grafana/client.js';
export { createPanelActions } from './actions/panelActions.js';
export type {
  PanelActions,
  PanelActionInput,
  PanelScreenshotResult,
  PanelCsvResult,
  PanelCsvFileResult,
} from './actions/panelActions.js';
export { originMatchesConnection } from './connections/resolve.js';
