import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { GrafanaClient } from '../grafana/client.js';
import { registerGetAlertContext } from './getAlertContext.js';
import { registerFetchDashboard } from './fetchDashboard.js';
import { registerResolvePanelQueries } from './resolvePanelQueries.js';
import { registerExecuteQueryWindow } from './executeQueryWindow.js';
import { registerFindRelatedDashboards } from './findRelatedDashboards.js';
import { registerDetectCorrelatedAnomalies } from './detectCorrelatedAnomalies.js';
import { registerValidateBaseline } from './validateBaseline.js';
import { registerSummarizeFindings } from './summarizeFindings.js';

export interface ToolContext {
  client: GrafanaClient;
  config: Config;
}

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerGetAlertContext(server, ctx);
  registerFetchDashboard(server, ctx);
  registerResolvePanelQueries(server, ctx);
  registerExecuteQueryWindow(server, ctx);
  registerFindRelatedDashboards(server, ctx);
  registerDetectCorrelatedAnomalies(server, ctx);
  registerValidateBaseline(server, ctx);
  registerSummarizeFindings(server, ctx);
}
