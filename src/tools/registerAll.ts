import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { ConnectionRegistry } from '../grafana/registry.js';
import type { LogConnectionRegistry } from '../graylog/registry.js';
import type { Screenshotter } from '../screenshot/types.js';
import type { ActivityLog } from '../activity/activityLog.js';
import { registerGetAlertContext } from './getAlertContext.js';
import { registerGetProductContext } from './getProductContext.js';
import { registerFetchDashboard } from './fetchDashboard.js';
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
  registerGetProductContext(server, ctx);
  registerFetchDashboard(server, ctx);
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
}
