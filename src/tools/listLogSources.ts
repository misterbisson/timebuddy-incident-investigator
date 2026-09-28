import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { toolErrorResult } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';
import { listLogSources, resolveLogSource } from '../logs/sources.js';

export function registerListLogSources(server: McpServer, { registry, logRegistry, config }: ToolContext): void {
  server.registerTool(
    'list_log_sources',
    {
      title: 'List log sources',
      description:
        'Lists every place logs can be searched, with each one\'s id, name, sourceType, and tags: configured ' +
        'Graylog connections (sourceType "graylog", with a default stream if one is set), and every Loki ' +
        'datasource on every Grafana connection (sourceType "loki", id "<grafanaConnection>/<datasourceUid>", ' +
        'tags inherited from that Grafana connection). The log-side counterpart to list_datasources — ' +
        'cross-reference a source\'s "tags" against a Grafana connection\'s own tags (see list_datasources) to ' +
        'pair the right log source with the dashboard/alert you\'re investigating, instead of guessing or asking ' +
        'when there\'s only one obvious match. A service may log to Loki rather than Graylog (or both), so check ' +
        'every source that matches before concluding there are no logs. "lokiDiscoveryProblems" lists Grafana ' +
        'connections whose datasources couldn\'t be read — a Loki source there may exist but isn\'t listed. Pass ' +
        '"connection" (a source id) to also list what can scope a search there: a Graylog connection\'s streams ' +
        '(id + title, for "streamId"), or a Loki source\'s stream label names (for a {label="..."} selector — get ' +
        'a label\'s values with discover_label_values).',
      inputSchema: {
        connection: z
          .string()
          .optional()
          .describe('Also list this source\'s streams (Graylog) or stream label names (Loki); omit to just list every log source'),
      },
      annotations: { readOnlyHint: true, title: 'List log sources' },
    },
    async ({ connection }) => {
      try {
        return await withAudit('list_log_sources', { connection }, config, async () => {
          const { sources, problems } = await listLogSources(logRegistry, registry);

          let detail: Record<string, unknown> = {};
          if (connection) {
            const resolved = await resolveLogSource(logRegistry, registry, connection);
            if (resolved.sourceType === 'graylog') {
              detail = { streams: (await resolved.client.listStreams()).map((s) => ({ id: s.id, title: s.title })) };
            } else {
              detail = { labels: await resolved.client.getLokiLabelNames(resolved.source.datasourceUid) };
            }
          }

          const result = {
            sources,
            ...(problems.length > 0 ? { lokiDiscoveryProblems: problems } : {}),
            ...detail,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        return toolErrorResult(err, config);
      }
    },
  );
}
