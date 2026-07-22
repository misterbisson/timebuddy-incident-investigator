import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import type { DsQueryRequest, DsQueryResponse } from '../grafana/types.js';
import type { GrafanaClient } from '../grafana/client.js';
import { resolveToolClient, toolErrorResult } from './shared.js';
import { extractTagValues } from './liveVariables.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

/** SHOW queries are schema catalog reads, not time-bucketed data — the window just needs to be non-degenerate. */
const SCHEMA_QUERY_WINDOW_MS = 5 * 60_000;

/**
 * Escapes a string for literal (non-regex) use inside an InfluxQL `/regex/`
 * literal — every regex metacharacter, including the `/` delimiter itself, is
 * escaped, so searchTerm can only ever match as a plain substring. This is
 * what keeps a caller-supplied string from breaking out of the regex literal
 * into the surrounding SHOW MEASUREMENTS statement.
 */
export function escapeInfluxRegexLiteral(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Escapes a measurement name for use inside a double-quoted InfluxQL identifier. */
export function escapeInfluxIdentifier(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Case-insensitive match is `(?i)` inline in InfluxQL/Go regex syntax, not a trailing `/i` flag. */
export function buildShowMeasurementsQuery(searchTerm: string): string {
  return `SHOW MEASUREMENTS WITH MEASUREMENT =~ /(?i)${escapeInfluxRegexLiteral(searchTerm)}/`;
}

export function buildShowFieldKeysQuery(measurement: string): string {
  return `SHOW FIELD KEYS FROM "${escapeInfluxIdentifier(measurement)}"`;
}

export function buildShowTagKeysQuery(measurement: string): string {
  return `SHOW TAG KEYS FROM "${escapeInfluxIdentifier(measurement)}"`;
}

/** Enumerates the actual values (e.g. the concrete hosts/IPs) of one tag key on one measurement — both identifiers double-quoted so neither can break out of the statement. */
export function buildShowTagValuesQuery(measurement: string, tagKey: string): string {
  return `SHOW TAG VALUES FROM "${escapeInfluxIdentifier(measurement)}" WITH KEY = "${escapeInfluxIdentifier(tagKey)}"`;
}

/** Flattens every non-time field's string values across every frame into a deduped, sorted name list. */
export function parseNameListFrames(response: DsQueryResponse): { names: string[]; errors: Record<string, string> } {
  const names = new Set<string>();
  const errors: Record<string, string> = {};
  for (const [refId, result] of Object.entries(response.results)) {
    if (result.error) {
      errors[refId] = result.error;
      continue;
    }
    for (const frame of result.frames ?? []) {
      frame.schema.fields.forEach((field, idx) => {
        if (field.type === 'time') return;
        const values = frame.data.values[idx] ?? [];
        for (const v of values) {
          if (typeof v === 'string' && v.length > 0) names.add(v);
        }
      });
    }
  }
  return { names: [...names].sort(), errors };
}

/** Resolves which InfluxDB datasource to query: an explicit uid must actually be InfluxDB-typed; otherwise there must be exactly one InfluxDB datasource on the connection. Ambiguous or missing is a hard error, never a guess. */
async function resolveInfluxDbDatasourceUid(client: GrafanaClient, requestedUid: string | undefined): Promise<string> {
  const datasources = await client.listDatasources();
  if (requestedUid) {
    const found = datasources.find((d) => d.uid === requestedUid);
    if (!found) {
      throw new Error(`No datasource with uid "${requestedUid}" on this connection.`);
    }
    if (found.type !== 'influxdb') {
      throw new Error(
        `Datasource "${requestedUid}" (${found.name}) is type "${found.type}", not influxdb — ` +
          'discover_influxdb_schema only supports InfluxDB datasources currently.',
      );
    }
    return requestedUid;
  }
  const influxDatasources = datasources.filter((d) => d.type === 'influxdb');
  if (influxDatasources.length === 0) {
    throw new Error('No InfluxDB datasource is configured on this connection.');
  }
  if (influxDatasources.length > 1) {
    throw new Error(
      'Multiple InfluxDB datasources are configured on this connection — pass datasourceUid to pick one: ' +
        influxDatasources.map((d) => `${d.name} (${d.uid})`).join(', '),
    );
  }
  return influxDatasources[0]!.uid;
}

async function runShowQuery(client: GrafanaClient, datasourceUid: string, query: string): Promise<{ names: string[]; error?: string }> {
  const nowMs = Date.now();
  const request: DsQueryRequest = {
    from: String(nowMs - SCHEMA_QUERY_WINDOW_MS),
    to: String(nowMs),
    queries: [
      {
        refId: 'A',
        datasource: { uid: datasourceUid },
        query,
        rawQuery: true,
        resultFormat: 'table',
      },
    ],
  };
  const response = await client.queryDs(request);
  const { names, errors } = parseNameListFrames(response);
  return { names, error: errors.A };
}

/**
 * Runs a SHOW TAG VALUES query and parses its key/value frame with the same
 * extractTagValues() the live-variable resolver uses — parseNameListFrames is
 * wrong here because it would also collect the repeated tag-key column, not
 * just the values. Returns a sorted, deduped value list.
 */
async function runTagValuesQuery(client: GrafanaClient, datasourceUid: string, query: string): Promise<{ values: string[]; error?: string }> {
  const nowMs = Date.now();
  const request: DsQueryRequest = {
    from: String(nowMs - SCHEMA_QUERY_WINDOW_MS),
    to: String(nowMs),
    queries: [{ refId: 'A', datasource: { uid: datasourceUid }, query, rawQuery: true, resultFormat: 'table' }],
  };
  const response = await client.queryDs(request);
  return { values: extractTagValues(response).sort(), error: response.results.A?.error };
}

export function registerDiscoverInfluxdbSchema(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'discover_influxdb_schema',
    {
      title: 'Discover InfluxDB schema',
      description:
        'Queries an InfluxDB datasource directly for its own measurement/field/tag schema — not dashboarded ' +
        'data, not time-series values. This is a last resort: use it only after find_related_dashboards has ' +
        'already been searched for a specific metric/measurement name and returned nothing relevant, and you ' +
        'have independent evidence the metric should exist (it\'s named in an alert, error message, or log ' +
        'line) — not as a first move or speculative exploration. Requires a non-empty searchTerm (a ' +
        'case-insensitive substring match against measurement names); there is deliberately no "list every ' +
        'measurement" mode, to keep this from being reached for casually. When searchTerm matches exactly one ' +
        'measurement, the result also includes that measurement\'s fieldKeys and tagKeys (its schema) so you ' +
        'can tell what could be visualized or grouped by; when it matches more than one, only names come back ' +
        '— narrow searchTerm and call again for one measurement\'s schema. When searchTerm resolves to exactly ' +
        'one measurement, also pass "tagKey" (one of that measurement\'s tagKeys) to enumerate that tag\'s actual ' +
        'values via SHOW TAG VALUES — the concrete hosts/IPs/instances that panels aggregate across and never ' +
        'reveal on their own. That is how you obtain a real hostname or IP to feed a log search (search_logs) ' +
        'instead of inventing one; only values actually returned here are safe to search on. Currently supports ' +
        'InfluxDB only ' +
        '(other datasource types are out of scope for now). Goes through the same connection resolution, ' +
        'redaction, and audit logging as every other tool.',
      inputSchema: {
        searchTerm: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe('Case-insensitive substring match against InfluxDB measurement names — required, no wildcard/list-all mode'),
        tagKey: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('Enumerate this tag key\'s actual values (e.g. host/instance) — requires searchTerm to match exactly one measurement, and the key to be one of its tagKeys'),
        datasourceUid: z.string().optional().describe('Which InfluxDB datasource to query; omit when the connection has exactly one'),
        limit: z.number().optional().default(50).describe('Max measurement names — and tag values — to return; see measurementsTotal / schema.tagValues.valuesTotal for the untruncated counts'),
        connection: z.string().optional().describe('Which Grafana connection to use; omit when only one is configured'),
      },
      annotations: { readOnlyHint: true, title: 'Discover InfluxDB schema' },
    },
    async ({ searchTerm, tagKey, datasourceUid, limit, connection }) => {
      try {
        return await withAudit('discover_influxdb_schema', { searchTerm, tagKey, datasourceUid, connection }, config, async () => {
          const { client, connectionId } = resolveToolClient(registry, { connection });
          const resolvedUid = await resolveInfluxDbDatasourceUid(client, datasourceUid);

          const measurementsResult = await runShowQuery(client, resolvedUid, buildShowMeasurementsQuery(searchTerm));
          if (measurementsResult.error) {
            throw new Error(`InfluxDB SHOW MEASUREMENTS failed: ${measurementsResult.error}`);
          }

          // Enumerating tag values only makes sense for a single measurement — a
          // key can differ per measurement, and there's no schema block to hang
          // the result off when the search is still ambiguous. Fail loudly rather
          // than silently ignoring tagKey.
          if (tagKey && measurementsResult.names.length !== 1) {
            throw new Error(
              `tagKey "${tagKey}" was given, but searchTerm "${searchTerm}" matched ${measurementsResult.names.length} measurement(s)` +
                (measurementsResult.names.length > 1 ? `: ${measurementsResult.names.slice(0, limit).join(', ')}` : '') +
                '. Narrow searchTerm to exactly one measurement to enumerate a tag key\'s values.',
            );
          }

          let schema:
            | { measurement: string; fieldKeys: string[]; tagKeys: string[]; tagValues?: { key: string; values: string[]; valuesTotal: number } }
            | undefined;
          if (measurementsResult.names.length === 1) {
            const measurement = measurementsResult.names[0]!;
            const [fieldKeysResult, tagKeysResult] = await Promise.all([
              runShowQuery(client, resolvedUid, buildShowFieldKeysQuery(measurement)),
              runShowQuery(client, resolvedUid, buildShowTagKeysQuery(measurement)),
            ]);
            schema = { measurement, fieldKeys: fieldKeysResult.names, tagKeys: tagKeysResult.names };

            if (tagKey) {
              // Guard against a silently-empty result being read as "no hosts":
              // a key that isn't on this measurement is a caller error, not an
              // empty set. List the real keys so they can fix the call.
              if (!tagKeysResult.names.includes(tagKey)) {
                throw new Error(
                  `Tag key "${tagKey}" is not a tag on measurement "${measurement}". ` +
                    `Available tag keys: ${tagKeysResult.names.join(', ') || '(none)'}.`,
                );
              }
              const tagValuesResult = await runTagValuesQuery(client, resolvedUid, buildShowTagValuesQuery(measurement, tagKey));
              if (tagValuesResult.error) {
                throw new Error(`InfluxDB SHOW TAG VALUES failed: ${tagValuesResult.error}`);
              }
              schema.tagValues = { key: tagKey, values: tagValuesResult.values.slice(0, limit), valuesTotal: tagValuesResult.values.length };
            }
          }

          const result = {
            connectionId,
            datasourceUid: resolvedUid,
            searchTerm,
            measurements: measurementsResult.names.slice(0, limit),
            measurementsTotal: measurementsResult.names.length,
            schema,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        return toolErrorResult(err, config);
      }
    },
  );
}
