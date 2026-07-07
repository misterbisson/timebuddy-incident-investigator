import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { flattenPanels, resolvePanelDataLinks } from '../dashboards/panelQueries.js';
import { dashboardUrlFor, resolveToolClient, toolErrorText } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

export function registerFetchDashboard(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'fetch_dashboard',
    {
      title: 'Fetch dashboard',
      description:
        'Fetches a Grafana dashboard by UID: its metadata, the flat list of panels (id, title, type), and its ' +
        'template variables. Use resolve_panel_queries to get a specific panel\'s query targets with variables ' +
        'substituted (including its dataLinks, if hasDataLinks is true here). If more than one panel in this list ' +
        'shares the same id (a provisioning quirk seen on some real dashboards, not standard Grafana behavior — ' +
        'titles differ even though ids collide), pass panelTitle alongside panelId on every other tool call for ' +
        'that panel, or those calls will fail with an ambiguous-panel error rather than silently picking one.',
      inputSchema: {
        dashboardUid: z.string().describe('Grafana dashboard UID'),
        connection: z.string().optional().describe('Connection id to use, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Fetch dashboard' },
    },
    async ({ dashboardUid, connection }) => {
      let resolvedConnectionId: string | undefined;
      try {
        return await withAudit('fetch_dashboard', { dashboardUid }, config, async () => {
          const { client, connectionId } = resolveToolClient(registry, { connection });
          resolvedConnectionId = connectionId;
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
        const url = resolvedConnectionId ? dashboardUrlFor(registry, resolvedConnectionId, dashboardUid) : undefined;
        return { content: [{ type: 'text' as const, text: toolErrorText(err, url) }], isError: true };
      }
    },
  );
}
