import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { parseGrafanaUrl } from '../alerts/urlParser.js';
import { flattenPanels, resolvePanelDataLinks } from '../dashboards/panelQueries.js';
import { dashboardUrlFor, resolveToolClient, toolErrorResult } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

export function registerFetchDashboard(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'fetch_dashboard',
    {
      title: 'Fetch dashboard',
      description:
        'Fetches a Grafana dashboard: its metadata, the flat list of panels (id, title, type), and its template ' +
        'variables. Pass a dashboard/panel or alert-rule URL (the connection is auto-detected from its host, the ' +
        'same as render_dashboard/screenshot_panel/export_panel_csv) or a dashboardUid + connection directly. ' +
        'Useful on its own to find a panel\'s id/type from its title before calling one of those other tools by ' +
        'name rather than id. Use resolve_panel_queries to get a specific panel\'s query targets with variables ' +
        'substituted (including its dataLinks, if hasDataLinks is true here). If more than one panel in this list ' +
        'shares the same id (a provisioning quirk seen on some real dashboards, not standard Grafana behavior — ' +
        'titles differ even though ids collide), pass panelTitle alongside panelId on every other tool call for ' +
        'that panel, or those calls will fail with an ambiguous-panel error rather than silently picking one.',
      inputSchema: {
        url: z.string().optional().describe('A Grafana dashboard/panel or alert-rule URL'),
        dashboardUid: z.string().optional().describe('Dashboard UID, when not passing url'),
        connection: z.string().optional().describe('Connection id to use, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Fetch dashboard' },
    },
    async ({ url, dashboardUid: inputDashboardUid, connection }) => {
      let resolvedConnectionId: string | undefined;
      let resolvedDashboardUid: string | undefined;
      try {
        return await withAudit('fetch_dashboard', { url, dashboardUid: inputDashboardUid }, config, async () => {
          const { client, connectionId } = resolveToolClient(registry, { connection, hintUrl: url });
          resolvedConnectionId = connectionId;

          let dashboardUid = inputDashboardUid;
          if (url) {
            const parsed = parseGrafanaUrl(url);
            if (parsed.type === 'dashboard') {
              dashboardUid = parsed.uid;
            } else {
              // Alert-rule URL: resolve its linked dashboard the same way
              // get_alert_context/render_dashboard do.
              const rule = await client.getAlertRuleByUid(parsed.ruleUid);
              const dashUid = rule.annotations?.__dashboardUid__;
              if (!dashUid) {
                throw new Error(
                  `Alert rule "${rule.title}" has no linked dashboard panel - fetch_dashboard needs a dashboard to ` +
                    "fetch. Use find_related_dashboards with the rule's labels to locate relevant dashboards.",
                );
              }
              dashboardUid = dashUid;
            }
          }
          if (!dashboardUid) {
            throw new Error('Must provide either "url" (a dashboard or alert-rule link) or "dashboardUid".');
          }
          resolvedDashboardUid = dashboardUid;

          const { dashboard, meta } = await client.getDashboard(dashboardUid);
          const panels = flattenPanels(dashboard.panels ?? []).map((p) => ({
            id: p.id,
            title: p.title,
            type: p.type,
            hasTargets: Boolean(p.targets?.length),
            hasDataLinks: resolvePanelDataLinks(p).length > 0,
            url: dashboardUrlFor(registry, connectionId, dashboardUid, { panelId: p.id }),
          }));
          const result = redact(
            {
              uid: dashboard.uid,
              title: dashboard.title,
              tags: dashboard.tags,
              folderTitle: meta.folderTitle,
              url: dashboardUrlFor(registry, connectionId, dashboardUid),
              panels,
              variables: (dashboard.templating?.list ?? []).map((v) => ({
                name: v.name,
                type: v.type,
                current: v.current,
                multi: v.multi,
              })),
            },
            config.redactionPatterns,
          );
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        });
      } catch (err) {
        const errorUrl = resolvedConnectionId && resolvedDashboardUid ? dashboardUrlFor(registry, resolvedConnectionId, resolvedDashboardUid) : undefined;
        return toolErrorResult(err, config, errorUrl);
      }
    },
  );
}
