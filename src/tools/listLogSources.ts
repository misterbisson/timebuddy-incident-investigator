import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import type { GraylogStream } from '../graylog/types.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

interface LogConnectionSummary {
  id: string;
  name: string;
  sourceType: 'graylog';
  tags: string[];
  streamId?: string;
  streamName?: string;
}

export function registerListLogSources(server: McpServer, { logRegistry, config }: ToolContext): void {
  server.registerTool(
    'list_log_sources',
    {
      title: 'List log sources',
      description:
        'Lists every configured log connection (id, name, sourceType, tags) — the log-side counterpart to ' +
        'list_datasources. With no arguments this is the "what log sources exist" survey; pass "connection" to ' +
        'also list that connection\'s available Graylog streams. Compare "tags" here against list_datasources\' ' +
        'connectionTags to pair a log connection with the Grafana connection covering the same environment — if ' +
        'exactly one log connection shares a tag with the Grafana connection in play, use it; if none or several ' +
        'do, ask which one to use rather than guessing.',
      inputSchema: {
        connection: z.string().optional().describe('Also list this log connection\'s available Graylog streams'),
      },
      annotations: { readOnlyHint: true, title: 'List log sources' },
    },
    async ({ connection }) => {
      try {
        return await withAudit('list_log_sources', { connection }, config, async () => {
          const connections = logRegistry.list();
          const sources: LogConnectionSummary[] = connections.map((c) => ({
            id: c.id,
            name: c.name,
            sourceType: c.sourceType,
            tags: c.tags ?? [],
            streamId: c.streamId,
            streamName: c.streamName,
          }));

          let streams: GraylogStream[] | undefined;
          let streamsError: string | undefined;
          if (connection) {
            try {
              streams = await logRegistry.get(connection).listStreams();
            } catch (err) {
              streamsError = err instanceof Error ? err.message : String(err);
            }
          }

          const result = { sources, streams, streamsError };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
