import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { ConnectionRegistry } from '../grafana/registry.js';
import type { Screenshotter } from '../screenshot/types.js';
import { registerGetAlertContext } from './getAlertContext.js';
import { registerFetchDashboard } from './fetchDashboard.js';
import { registerResolvePanelQueries } from './resolvePanelQueries.js';
import { registerExecuteQueryWindow } from './executeQueryWindow.js';
import { registerRenderDashboard } from './renderDashboard.js';
import { registerScreenshotPanel } from './screenshotPanel.js';
import { registerFindRelatedDashboards } from './findRelatedDashboards.js';
import { registerDetectCorrelatedAnomalies } from './detectCorrelatedAnomalies.js';
import { registerValidateBaseline } from './validateBaseline.js';
import { registerSummarizeFindings } from './summarizeFindings.js';
import { registerListDatasources } from './listDatasources.js';

export interface ToolContext {
  registry: ConnectionRegistry;
  config: Config;
  /** Only supplied by the Electron app's --mcp-server mode; see screenshot/types.ts. */
  screenshotter?: Screenshotter;
}

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerGetAlertContext(server, ctx);
  registerFetchDashboard(server, ctx);
  registerResolvePanelQueries(server, ctx);
  registerExecuteQueryWindow(server, ctx);
  registerRenderDashboard(server, ctx);
  registerFindRelatedDashboards(server, ctx);
  registerDetectCorrelatedAnomalies(server, ctx);
  registerValidateBaseline(server, ctx);
  registerSummarizeFindings(server, ctx);
  registerListDatasources(server, ctx);
  // No browser to drive the client-side capture with in the standalone CLI —
  // omit the tool entirely rather than registering something that always errors.
  if (ctx.screenshotter) registerScreenshotPanel(server, ctx as ToolContext & { screenshotter: Screenshotter });
}
