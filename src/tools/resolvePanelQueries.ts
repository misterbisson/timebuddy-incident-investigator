import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { findPanel, resolvePanelQueries as resolveAllPanelQueries, stripInactiveQueryFields } from '../dashboards/panelQueries.js';
import { substituteTargetFields } from '../dashboards/variables.js';
import { dashboardUrlFor, epochMsSchema, resolveTargetDatasource, resolveToolClient, toolErrorResult } from './shared.js';
import { materializeVariables } from './liveVariables.js';
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
        'current value. For an InfluxQL target, "resolvedQuery" includes only the representation Grafana actually ' +
        'runs — its raw-text "query" string when the target\'s "rawQuery" is true, or its structured builder fields ' +
        '(measurement/tags/...) when false — never both; the two are edited independently in Grafana\'s query editor ' +
        'and the unused one can be stale, so don\'t read a "query" text field as live unless "rawQuery" is true. Each ' +
        'panel also returns "dataLinks" — Grafana drill-down link templates (e.g. a table\'s ' +
        '"click a row to see that account/host\'s dashboard"), as raw URL templates containing macros like ' +
        '${__from}/${__to}/${__data.fields["X"]} that this server doesn\'t resolve. Substitute those yourself using ' +
        'the window bounds and the actual field values from the panel\'s query result (e.g. via execute_query_window) ' +
        'to build a working link — this is usually the way to "follow" a panel\'s links when investigating. ' +
        'Returns { panels, unresolvedAllVariables }: panels as described above, plus unresolvedAllVariables (omitted ' +
        'when empty) listing any "$__all"-selected variable this couldn\'t live-resolve to its real value list (falls ' +
        'back to matching everything instead) — treat a panel depending on one of those as unscoped/unverified. A ' +
        'panel using Grafana\'s built-in "-- Dashboard --" datasource carries "mirrorsPanelIds" — it re-displays ' +
        'another panel\'s already-computed value client-side and has no backend to query (always 404s if replayed via ' +
        'execute_query_window); read the referenced panel(s) instead.',
      inputSchema: {
        dashboardUid: z.string().describe('Grafana dashboard UID'),
        panelId: z.number().optional().describe('Limit to one panel; omit to resolve every queryable panel'),
        panelTitle: z.string().optional().describe('Exact panel title — required only when panelId is ambiguous (multiple panels sharing one id, seen on some provisioned dashboards); the error message lists the candidates when this happens'),
        variableOverrides: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe('Variable name -> value(s), e.g. from a panel URL\'s var-* query params'),
        windowFromMs: epochMsSchema.optional().describe('Epoch ms or ISO 8601 date/time used to evaluate $__interval/$__range/$timeFilter; defaults to 1h ago'),
        windowToMs: epochMsSchema.optional().describe('Epoch ms or ISO 8601 date/time used to evaluate $__interval/$__range/$timeFilter; defaults to now'),
        connection: z.string().optional().describe('Connection id to use, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Resolve panel queries' },
    },
    async ({ dashboardUid, panelId, panelTitle, variableOverrides, windowFromMs, windowToMs, connection }) => {
      let resolvedConnectionId: string | undefined;
      try {
        return await withAudit('resolve_panel_queries', { dashboardUid, panelId }, config, async () => {
          const { client, connectionId } = resolveToolClient(registry, { connection });
          resolvedConnectionId = connectionId;
          const { dashboard } = await client.getDashboard(dashboardUid);
          const variables = dashboard.templating?.list ?? [];
          const overrides = variableOverrides ?? {};
          const window = {
            fromMs: windowFromMs ?? Date.now() - 3_600_000,
            toMs: windowToMs ?? Date.now(),
          };
          const { overrides: resolvedOverrides, unresolvedAllVariables } = await materializeVariables(client, variables, overrides, window);

          const panels = panelId !== undefined
            ? [findPanel(dashboard, panelId, panelTitle)].filter((p): p is NonNullable<typeof p> => Boolean(p))
            : resolveAllPanelQueries(dashboard);

          if (panelId !== undefined && panels.length === 0) {
            throw new Error(`Panel ${panelId} not found on dashboard ${dashboardUid}`);
          }

          const result = await Promise.all(
            panels.map(async (panel) => ({
              panelId: panel.panelId,
              title: panel.title,
              type: panel.type,
              url: dashboardUrlFor(registry, connectionId, dashboardUid, { panelId: panel.panelId, fromMs: window.fromMs, toMs: window.toMs }),
              ...(panel.mirrorsPanelIds ? { mirrorsPanelIds: panel.mirrorsPanelIds } : {}),
              // Raw URL templates (Grafana "data links"), not resolved — see
              // resolvePanelDataLinks' doc comment. Substitute
              // ${__from}/${__to} with window.fromMs/toMs and
              // ${__data.fields["X"]} with each row's actual field value
              // from this panel's query result to build a working link.
              dataLinks: panel.dataLinks,
              targets: await Promise.all(
                panel.targets.map(async (t) => ({
                  refId: t.refId,
                  datasourceUid: await resolveTargetDatasource(client, t.datasourceUid, variables, resolvedOverrides),
                  resolvedQuery: stripInactiveQueryFields(substituteTargetFields(t.raw, variables, resolvedOverrides, window, config.maxDataPoints)),
                })),
              ),
            })),
          );

          const response = {
            panels: result,
            ...(unresolvedAllVariables.length > 0 ? { unresolvedAllVariables } : {}),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(response, config.redactionPatterns)) }] };
        });
      } catch (err) {
        const url = resolvedConnectionId ? dashboardUrlFor(registry, resolvedConnectionId, dashboardUid, { panelId }) : undefined;
        return toolErrorResult(err, config, url);
      }
    },
  );
}
