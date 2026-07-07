import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import type { DatasourceInfo } from '../grafana/types.js';
import { resolveToolClient } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

interface DatasourceSummary {
  uid: string;
  name: string;
  type: string;
  isDefault?: boolean;
}

function toSummary(d: DatasourceInfo): DatasourceSummary {
  return { uid: d.uid, name: d.name, type: d.type, isDefault: d.isDefault };
}

function matchesQuery(query: string, d: DatasourceInfo): boolean {
  const q = query.toLowerCase();
  return d.name.toLowerCase().includes(q) || d.type.toLowerCase().includes(q);
}

/** Filters and summarizes a connection's datasources for the tool response — exported for direct testing. */
export function filterDatasources(datasources: DatasourceInfo[], query?: string): DatasourceSummary[] {
  const filtered = query ? datasources.filter((d) => matchesQuery(query, d)) : datasources;
  return filtered.map(toSummary);
}

export function registerListDatasources(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'list_datasources',
    {
      title: 'List datasources',
      description:
        'Lists the datasources configured on a Grafana connection: uid, name, type, and which one is the default. ' +
        'The main use: checking whether a datasource a panel references by a literal name rather than a UID (e.g. ' +
        'a non-"$"-prefixed entry in find_related_dashboards\'s brokenDatasources) still exists under some other ' +
        'UID — if a matching name shows up here, that reference is fixable (Grafana-side, by correcting the ' +
        'panel\'s datasource UID); if nothing close appears, the datasource was genuinely deleted/renamed with no ' +
        'trace and no tool can resolve that reference, only a Grafana-side fix can. Pass "query" to filter by a ' +
        'case-insensitive substring match against name/type. Pass "connection" to check one connection; omit it to ' +
        'check every configured connection.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring match against datasource name or type'),
        connection: z.string().optional().describe('Check only this connection; omit to fan out across every configured connection'),
      },
      annotations: { readOnlyHint: true, title: 'List datasources' },
    },
    async ({ query, connection }) => {
      try {
        return await withAudit('list_datasources', { query }, config, async () => {
          const connections = connection
            ? [resolveToolClient(registry, { connection }).connectionId]
            : registry.list().map((c) => c.id);

          const perConnection = await Promise.allSettled(
            connections.map(async (connectionId) => {
              const client = registry.get(connectionId);
              const datasources = await client.listDatasources();
              return { connectionId, datasources: filterDatasources(datasources, query) };
            }),
          );

          const fulfilled = perConnection.filter(
            (r): r is PromiseFulfilledResult<{ connectionId: string; datasources: DatasourceSummary[] }> =>
              r.status === 'fulfilled',
          );

          const result = {
            datasourcesByConnection: Object.fromEntries(fulfilled.map((r) => [r.value.connectionId, r.value.datasources])),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns), null, 2) }] };
        });
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
