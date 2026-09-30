import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import type { GrafanaClient } from '../grafana/client.js';
import { epochMsSchema, labelLookbackHours, resolveLabelWindow, resolveToolClient, toolErrorResult, type LabelWindowReport } from './shared.js';
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
async function enumerateValues(
  client: GrafanaClient,
  type: SupportedType,
  uid: string,
  metric: string,
  label: string,
  lokiWindow: { fromMs: number; toMs: number } | undefined,
): Promise<string[]> {
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
    values = await client.getLokiLabelValues(uid, label, lokiWindow!, metric);
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
        'query failure (or an unrecognized response) is a hard error — but note that a mistyped label or metric name ' +
        'is NOT an error to the datasource, it just matches nothing, so an empty "values" can mean either "no values ' +
        'in scope" or "wrong label/metric name". Verify the names against the panel\'s own series labels / ' +
        'discover_influxdb_schema tagKeys before concluding a set is truly empty. Loki only returns values seen in a ' +
        'time range, so for Loki pass the incident window as startsAtMs/endsAtMs; without them it covers the last ' +
        `${labelLookbackHours(config)} hours, and "window" reports the range actually used. Goes through the same connection ` +
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
        startsAtMs: epochMsSchema
          .optional()
          .describe(`Loki only: start of the range to list values over — epoch ms or ISO 8601; defaults to ${labelLookbackHours(config)} hours before endsAtMs`),
        endsAtMs: epochMsSchema.optional().describe('Loki only: end of that range — epoch ms or ISO 8601; defaults to now'),
        connection: z.string().optional().describe('Which Grafana connection to use; omit when only one is configured'),
      },
      annotations: { readOnlyHint: true, title: 'Discover label/tag values' },
    },
    async ({ metric, label, datasourceUid, limit, startsAtMs, endsAtMs, connection }) => {
      try {
        return await withAudit('discover_label_values', { metric, label, datasourceUid, startsAtMs, endsAtMs, connection }, config, async () => {
          const { client, connectionId } = resolveToolClient(registry, { connection });
          const { uid, type } = await resolveLabelDatasource(client, datasourceUid);
          let lokiWindow: { window: { fromMs: number; toMs: number }; report: LabelWindowReport } | undefined;
          if (type === 'loki') {
            lokiWindow = resolveLabelWindow(startsAtMs, endsAtMs, config);
          } else if (startsAtMs !== undefined || endsAtMs !== undefined) {
            // Refused rather than ignored: a caller passing a window expects it to scope the values.
            throw new Error(
              `startsAtMs/endsAtMs only apply to a Loki datasource; "${uid}" is ${type}, whose values here aren't ` +
                'time-scoped. Drop them for this datasource.',
            );
          }
          const values = await enumerateValues(client, type, uid, metric, label, lokiWindow?.window);
          const result = {
            connectionId,
            datasourceUid: uid,
            datasourceType: type,
            metric,
            label,
            values: values.slice(0, limit),
            valuesTotal: values.length,
            ...(lokiWindow ? { window: lokiWindow.report } : {}),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        return toolErrorResult(err, config);
      }
    },
  );
}
