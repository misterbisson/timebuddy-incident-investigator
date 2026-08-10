import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { ConnectionRegistry } from '../grafana/registry.js';
import type { LogConnectionRegistry } from '../graylog/registry.js';
import type { Screenshotter } from '../screenshot/types.js';
import type { ActivityLog } from '../activity/activityLog.js';
import { registerGetAlertContext } from './getAlertContext.js';
import { registerListFiringAlerts } from './listFiringAlerts.js';
import { registerGetProductContext } from './getProductContext.js';
import { registerFetchDashboard } from './fetchDashboard.js';
import { registerListFolderDashboards } from './listFolderDashboards.js';
import { registerResolvePanelQueries } from './resolvePanelQueries.js';
import { registerExecuteQueryWindow } from './executeQueryWindow.js';
import { registerRenderDashboard } from './renderDashboard.js';
import { registerScreenshotPanel } from './screenshotPanel.js';
import { registerExportPanelCsv } from './exportPanelCsv.js';
import { registerFindRelatedDashboards } from './findRelatedDashboards.js';
import { registerDetectCorrelatedAnomalies } from './detectCorrelatedAnomalies.js';
import { registerValidateBaseline } from './validateBaseline.js';
import { registerSummarizeFindings } from './summarizeFindings.js';
import { registerListDatasources } from './listDatasources.js';
import { registerDiscoverInfluxdbSchema } from './discoverInfluxdbSchema.js';
import { registerDiscoverLabelValues } from './discoverLabelValues.js';
import { registerSearchLogs } from './searchLogs.js';
import { registerListLogSources } from './listLogSources.js';
import { registerCorrelateLogs } from './correlateLogs.js';
import { registerExecuteAdhocQuery } from './executeAdhocQuery.js';

export interface ToolContext {
  registry: ConnectionRegistry;
  logRegistry: LogConnectionRegistry;
  config: Config;
  /** Only supplied by the Electron app's --mcp-server mode; see screenshot/types.ts. */
  screenshotter?: Screenshotter;
  /** Only supplied by the Electron app's --mcp-server mode, feeding its Activity window; see activity/activityLog.ts. */
  activityLog?: ActivityLog;
}

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerGetAlertContext(server, ctx);
  registerListFiringAlerts(server, ctx);
  registerGetProductContext(server, ctx);
  registerFetchDashboard(server, ctx);
  registerListFolderDashboards(server, ctx);
  registerResolvePanelQueries(server, ctx);
  registerExecuteQueryWindow(server, ctx);
  registerRenderDashboard(server, ctx);
  registerExportPanelCsv(server, ctx);
  registerFindRelatedDashboards(server, ctx);
  registerDetectCorrelatedAnomalies(server, ctx);
  registerValidateBaseline(server, ctx);
  registerSummarizeFindings(server, ctx);
  registerListDatasources(server, ctx);
  registerDiscoverInfluxdbSchema(server, ctx);
  registerDiscoverLabelValues(server, ctx);
  registerSearchLogs(server, ctx);
  registerListLogSources(server, ctx);
  registerCorrelateLogs(server, ctx);
  // No browser to drive the client-side capture with in the standalone CLI —
  // omit the tool entirely rather than registering something that always errors.
  if (ctx.screenshotter) registerScreenshotPanel(server, ctx as ToolContext & { screenshotter: Screenshotter });
  // Same reasoning, for a different reason to be absent: unless some workspace
  // authorized ad-hoc queries via --allow-adhoc-queries, this tool would refuse
  // every call, so don't advertise it at all. A model that can't see it can't
  // spend a turn discovering it isn't allowed — and in the overwhelmingly common
  // case (no flag anywhere) the server's tool list is byte-identical to what it
  // was before this feature existed.
  //
  // Note the asymmetry with the connections thunk: this is a startup decision,
  // because an MCP server advertises one tool list per session. Adding the flag
  // needs a session restart, unlike adding a connection.
  if ((ctx.config.adhocQueries ?? []).length > 0) registerExecuteAdhocQuery(server, ctx);
}
