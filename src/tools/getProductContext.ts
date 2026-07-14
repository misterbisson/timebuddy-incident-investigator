import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { dashboardUrlFor, resolveToolClient, toolErrorText } from './shared.js';
import { findProductContextAcrossConnection, resolveProductContext } from '../knowledge/lookup.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

export function registerGetProductContext(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'get_product_context',
    {
      title: 'Get product context',
      description:
        'Looks up a product\'s "Timebuddy knowledge" panel directly, by product key, without needing an alert in ' +
        'hand - useful while exploring or just poking around a service. Pass "dashboardUid" (any dashboard in the ' +
        "folder whose knowledge you want) to scope the search to that dashboard's folder and its ancestors (the " +
        'same walk-up get_alert_context uses); omit it to search every "Timebuddy knowledge" dashboard on the ' +
        'connection instead, which can return more than one match (e.g. the same product key defined for both ' +
        'staging and prod) rather than guessing which one you meant. Returns an empty "matches" array, with no ' +
        'error, when nothing has been published for this product - see README for the publishing convention.',
      inputSchema: {
        productKey: z.string().describe('The product key from a "timebuddy: <product-key>" panel title'),
        dashboardUid: z.string().optional().describe("Scope the search to this dashboard's folder (and its ancestors); omit to search the whole connection"),
        connection: z.string().optional().describe('Connection id to use, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Get product context' },
    },
    async ({ productKey, dashboardUid, connection }) => {
      try {
        return await withAudit('get_product_context', { productKey, dashboardUid }, config, async () => {
          const { client, connectionId } = resolveToolClient(registry, { connection });

          if (dashboardUid) {
            const { meta } = await client.getDashboard(dashboardUid);
            const found = await resolveProductContext(client, config, connectionId, {
              startFolderUid: meta.folderUid,
              candidateKeys: [productKey],
            });
            const matches = found
              ? [{ ...found, url: dashboardUrlFor(registry, connectionId, found.dashboardUid, { panelId: found.panelId }) }]
              : [];
            const result = { productKey, connection: connectionId, matches };
            return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
          }

          const found = await findProductContextAcrossConnection(client, config, connectionId, productKey);
          const matches = found.map((m) => ({ ...m, url: dashboardUrlFor(registry, connectionId, m.dashboardUid, { panelId: m.panelId }) }));
          const result = { productKey, connection: connectionId, matches };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        return { content: [{ type: 'text' as const, text: toolErrorText(err) }], isError: true };
      }
    },
  );
}
