import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import type { GrafanaClient } from '../grafana/client.js';
import { resolveToolClient, toolErrorResult } from './shared.js';
import { buildShowTagValuesQuery, runTagValuesQuery } from './discoverInfluxdbSchema.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

/**
 * The datasource types this tool can enumerate label/tag values for. Each maps
 * to that datasource's own "values of a label" primitive: InfluxDB SHOW TAG
 * VALUES, Prometheus label_values(metric, label), Loki's label-values API.
 */
const SUPPORTED_TYPES = ['influxdb', 'prometheus', 'loki'] as const;
type SupportedType = (typeof SUPPORTED_TYPES)[number];

function isSupported(type: string): type is SupportedType {
  return (SUPPORTED_TYPES as readonly string[]).includes(type);
}

/**
 * Picks which datasource to enumerate against: an explicit uid must be one of
 * the supported types; otherwise there must be exactly one supported datasource
 * on the connection. Ambiguous or missing is a hard error listing the
 * candidates, never a guess — the same contract as discover_influxdb_schema's
 * resolver, generalized across the three label-capable datasource types.
 */
async function resolveLabelDatasource(
  client: GrafanaClient,
  requestedUid: string | undefined,
): Promise<{ uid: string; type: SupportedType }> {
  const datasources = await client.listDatasources();
  if (requestedUid) {
    const found = datasources.find((d) => d.uid === requestedUid);
    if (!found) {
      throw new Error(`No datasource with uid "${requestedUid}" on this connection.`);
    }
    if (!isSupported(found.type)) {
      throw new Error(
        `Datasource "${requestedUid}" (${found.name}) is type "${found.type}", which discover_label_values ` +
          `doesn't support — only ${SUPPORTED_TYPES.join(', ')} datasources expose a label/tag value list.`,
      );
    }
    return { uid: requestedUid, type: found.type };
  }
  const supported = datasources.filter((d) => isSupported(d.type));
  if (supported.length === 0) {
    throw new Error('No InfluxDB, Prometheus, or Loki datasource is configured on this connection.');
  }
  if (supported.length > 1) {
    throw new Error(
      'Multiple label-capable datasources are configured on this connection — pass datasourceUid to pick one: ' +
        supported.map((d) => `${d.name} (${d.uid}, ${d.type})`).join(', '),
    );
  }
  // Narrowed by the isSupported filter above; the array element type stays the
  // wider string, so assert back to the branded union.
  return { uid: supported[0]!.uid, type: supported[0]!.type as SupportedType };
}

/** Dispatches the value enumeration to the right per-datasource primitive and returns a deduped, sorted list. */
async function enumerateValues(client: GrafanaClient, type: SupportedType, uid: string, metric: string, label: string): Promise<string[]> {
  let values: string[];
  if (type === 'influxdb') {
    // Reuse the exact proven SHOW TAG VALUES request shape (and error surfacing)
    // discover_influxdb_schema uses, rather than a second parallel copy.
    const result = await runTagValuesQuery(client, uid, buildShowTagValuesQuery(metric, label));
    if (result.error) {
      throw new Error(`InfluxDB SHOW TAG VALUES failed: ${result.error}`);
    }
    values = result.values;
  } else if (type === 'prometheus') {
    values = await client.getPrometheusLabelValues(uid, label, metric);
  } else {
    values = await client.getLokiLabelValues(uid, label, metric);
  }
  return [...new Set(values)].sort();
}

export function registerDiscoverLabelValues(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'discover_label_values',
    {
      title: 'Discover label/tag values',
      description:
        'Enumerates the actual values of one label/tag key for one metric, directly from the datasource — the ' +
        'datasource-agnostic counterpart to discover_influxdb_schema\'s tagKey enumeration, covering InfluxDB, ' +
        'Prometheus, and Loki. Dispatches by the datasource\'s type: InfluxDB runs SHOW TAG VALUES, Prometheus runs ' +
        'label_values(metric, label), Loki queries its label-values API. Use it for the same reason as the InfluxDB ' +
        'path: a panel aggregates across hosts/instances/pods and never reveals the concrete ones, and you need a ' +
        'real hostname/IP/instance to feed a log search (search_logs) instead of inventing one — only values ' +
        'actually returned here are safe to search on. Requires "metric" (the InfluxDB measurement / Prometheus ' +
        'metric name or series selector / Loki stream selector) and "label" (the key whose values you want, e.g. ' +
        '"host" / "instance" / "pod"). For Prometheus/Loki, get candidate label names from a panel\'s series labels ' +
        'or its query; for InfluxDB, discover_influxdb_schema lists a measurement\'s tagKeys. A datasource-level ' +
        'query failure is surfaced as a hard error rather than an empty list. Goes through the same connection ' +
        'resolution, redaction, and audit logging as every other tool.',
      inputSchema: {
        metric: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe('What to scope the values to: an InfluxDB measurement, a Prometheus metric name or series selector (e.g. up{job="x"}), or a Loki stream selector'),
        label: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe('The label/tag key whose values to enumerate, e.g. "host" / "instance" / "pod"'),
        datasourceUid: z.string().optional().describe('Which datasource to query (InfluxDB/Prometheus/Loki); omit when the connection has exactly one label-capable datasource'),
        limit: z.number().optional().default(50).describe('Max values to return; see valuesTotal for the untruncated count'),
        connection: z.string().optional().describe('Which Grafana connection to use; omit when only one is configured'),
      },
      annotations: { readOnlyHint: true, title: 'Discover label/tag values' },
    },
    async ({ metric, label, datasourceUid, limit, connection }) => {
      try {
        return await withAudit('discover_label_values', { metric, label, datasourceUid, connection }, config, async () => {
          const { client, connectionId } = resolveToolClient(registry, { connection });
          const { uid, type } = await resolveLabelDatasource(client, datasourceUid);
          const values = await enumerateValues(client, type, uid, metric, label);
          const result = {
            connectionId,
            datasourceUid: uid,
            datasourceType: type,
            metric,
            label,
            values: values.slice(0, limit),
            valuesTotal: values.length,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        return toolErrorResult(err, config);
      }
    },
  );
}
