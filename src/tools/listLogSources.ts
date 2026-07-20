import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { resolveLogToolClient, toolErrorResult } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

export function registerListLogSources(server: McpServer, { logRegistry, config }: ToolContext): void {
  server.registerTool(
    'list_log_sources',
    {
      title: 'List log sources',
      description:
        'Lists the configured Graylog connections: id, name, tags, and default stream (if one is set). The ' +
        'log-side counterpart to list_datasources — cross-reference a log connection\'s "tags" against a Grafana ' +
        'connection\'s own tags (see list_datasources) to pair the right log source with the dashboard/alert you\'re ' +
        'investigating, instead of guessing or asking when there\'s only one obvious match. Pass "connection" to ' +
        'also list that connection\'s available streams (id + title) for picking a "streamId" to pass to ' +
        'search_logs/correlate_logs.',
      inputSchema: {
        connection: z.string().optional().describe('Also list this connection\'s streams; omit to just list every configured log connection'),
      },
      annotations: { readOnlyHint: true, title: 'List log sources' },
    },
    async ({ connection }) => {
      try {
        return await withAudit('list_log_sources', { connection }, config, async () => {
          const sources = logRegistry.list().map((c) => ({
            id: c.id,
            name: c.name,
            sourceType: c.sourceType,
            tags: c.tags,
            streamId: c.streamId,
            streamName: c.streamName,
          }));

          let streams: Array<{ id: string; title: string }> | undefined;
          if (connection) {
            const { client } = resolveLogToolClient(logRegistry, { connection });
            streams = (await client.listStreams()).map((s) => ({ id: s.id, title: s.title }));
          }

          const result = { sources, ...(streams ? { streams } : {}) };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        return toolErrorResult(err, config);
      }
    },
  );
}
