import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { findPanel, resolvePanelQueries as resolveAllPanelQueries } from '../dashboards/panelQueries.js';
import { substituteTargetFields } from '../dashboards/variables.js';
import { epochMsSchema, resolveTargetDatasource, resolveToolClient } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

export function registerResolvePanelQueries(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'resolve_panel_queries',
    {
      title: 'Resolve panel queries',
      description:
        'Extracts a dashboard panel\'s query targets, resolves each target\'s datasource UID (including when the ' +
        'panel uses a datasource-picker template variable like $datasource/${DS_PROMETHEUS} rather than a fixed ' +
        'UID), and substitutes Grafana template variables ($var, ${var:format}, $__interval, $timeFilter, ...) into ' +
        'the query text. Pass variableOverrides captured from the alert/panel URL (var-*) to reproduce exactly what ' +
        'was on screen when the alert fired; any variable not overridden falls back to the dashboard\'s saved ' +
        'current value.',
      inputSchema: {
        dashboardUid: z.string().describe('Grafana dashboard UID'),
        panelId: z.number().optional().describe('Limit to one panel; omit to resolve every queryable panel'),
        variableOverrides: z
          .record(z.array(z.string()))
          .optional()
          .describe('Variable name -> value(s), e.g. from a panel URL\'s var-* query params'),
        windowFromMs: epochMsSchema.optional().describe('Epoch ms or ISO 8601 date/time used to evaluate $__interval/$__range/$timeFilter; defaults to 1h ago'),
        windowToMs: epochMsSchema.optional().describe('Epoch ms or ISO 8601 date/time used to evaluate $__interval/$__range/$timeFilter; defaults to now'),
        connection: z.string().optional().describe('Connection id to use, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Resolve panel queries' },
    },
    async ({ dashboardUid, panelId, variableOverrides, windowFromMs, windowToMs, connection }) => {
      try {
        return await withAudit('resolve_panel_queries', { dashboardUid, panelId }, config, async () => {
          const { client } = resolveToolClient(registry, { connection });
          const { dashboard } = await client.getDashboard(dashboardUid);
          const variables = dashboard.templating?.list ?? [];
          const overrides = variableOverrides ?? {};
          const window = {
            fromMs: windowFromMs ?? Date.now() - 3_600_000,
            toMs: windowToMs ?? Date.now(),
          };

          const panels = panelId !== undefined
            ? [findPanel(dashboard, panelId)].filter((p): p is NonNullable<typeof p> => Boolean(p))
            : resolveAllPanelQueries(dashboard);

          if (panelId !== undefined && panels.length === 0) {
            throw new Error(`Panel ${panelId} not found on dashboard ${dashboardUid}`);
          }

          const result = await Promise.all(
            panels.map(async (panel) => ({
              panelId: panel.panelId,
              title: panel.title,
              type: panel.type,
              targets: await Promise.all(
                panel.targets.map(async (t) => ({
                  refId: t.refId,
                  datasourceUid: await resolveTargetDatasource(client, t.datasourceUid, variables, overrides),
                  resolvedQuery: substituteTargetFields(t.raw, variables, overrides, window),
                })),
              ),
            })),
          );

          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns), null, 2) }] };
        });
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
