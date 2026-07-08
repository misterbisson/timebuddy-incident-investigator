import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { ConnectionRegistry } from '../grafana/registry.js';
import type { LogConnectionRegistry } from '../graylog/registry.js';
import { registerGetAlertContext } from './getAlertContext.js';
import { registerFetchDashboard } from './fetchDashboard.js';
import { registerResolvePanelQueries } from './resolvePanelQueries.js';
import { registerExecuteQueryWindow } from './executeQueryWindow.js';
import { registerFindRelatedDashboards } from './findRelatedDashboards.js';
import { registerDetectCorrelatedAnomalies } from './detectCorrelatedAnomalies.js';
import { registerValidateBaseline } from './validateBaseline.js';
import { registerSummarizeFindings } from './summarizeFindings.js';
import { registerListDatasources } from './listDatasources.js';
import { registerListLogSources } from './listLogSources.js';
import { registerSearchLogs } from './searchLogs.js';
import { registerCorrelateLogs } from './correlateLogs.js';

export interface ToolContext {
  registry: ConnectionRegistry;
  logRegistry: LogConnectionRegistry;
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
  registerListDatasources(server, ctx);
  registerListLogSources(server, ctx);
  registerSearchLogs(server, ctx);
  registerCorrelateLogs(server, ctx);
}
