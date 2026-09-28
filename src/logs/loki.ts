import type { GrafanaClient } from '../grafana/client.js';
import type { DsQueryResponse, GrafanaFrame } from '../grafana/types.js';
import { classifyLogQL } from '../query/logqlGuard.js';

/**
 * Log search against a Grafana `loki` datasource, through the same
 * already-allowlisted `POST /api/ds/query` every metric tool uses — the log
 * counterpart of GraylogClient.searchAbsolute (issue #265).
 *
 * The query is model-authored, same as a Graylog search_logs query, and like
 * that path it needs no per-workspace ad-hoc flag: it is guarded by
 * query/logqlGuard.ts (one expression, never rewritten, log queries only) and
 * reaches only Loki's query endpoint. See that module's header for why LogQL
 * can't express a write.
 */

/** One returned log line, in the shape search_logs emits and correlate_logs joins on. */
export interface LokiLine {
  /** ISO 8601, millisecond precision — what Graylog returns too, so both sources read the same. */
  timestamp: string;
  /** Nanosecond timestamp as Loki reported it, when present — ordering within one millisecond needs it. */
  timestampNs?: string;
  message: string;
  /** Stream labels, plus any labels the query's own pipeline extracted (| json, | logfmt, label_format ...). */
  labels: Record<string, string>;
}

export interface LokiSearchResult {
  /** The statement that ran — the guard's output, which is the caller's text trimmed. */
  statement: string;
  lines: LokiLine[];
  /**
   * Loki reports no total match count, so this can't be "total > fetched" the
   * way Graylog's is. It's true whenever the search returned as many lines as
   * it was allowed to: conservative, which is the direction correlate_logs'
   * `unless` refusal needs (a false "truncated" costs a retry; a false "not
   * truncated" inverts an anti-join).
   */
  truncated: boolean;
}

export interface LokiSearchParams {
  datasourceUid: string;
  query: string;
  fromMs: number;
  toMs: number;
  /**
   * Lines to return. Loki's own ceiling (`max_entries_limit_per_query`,
   * default 5000) errors rather than clipping above it, so a cap past it
   * surfaces as a query error, never as a silently shorter answer.
   */
  limit: number;
}

/**
 * Refuses a query search_logs can't answer, with the reason. Exported so the
 * correlate_logs adapter refuses the same things for the same reasons.
 */
export function guardLokiLogQuery(query: string): string {
  const verdict = classifyLogQL(query);
  if (!verdict.allowed) {
    throw new Error(`LogQL query refused: ${verdict.reason}`);
  }
  if (verdict.kind === 'metric') {
    throw new Error(
      'LogQL query refused: this is a metric query (it computes series, e.g. count_over_time or rate), but ' +
        'search_logs returns log lines. Pass the log query itself — a stream selector plus any pipeline, e.g. ' +
        '{app="checkout"} |= "error" — or run the metric query with execute_adhoc_query where a workspace has ' +
        'authorized it.',
    );
  }
  return verdict.statement;
}

function toRecord(value: unknown): Record<string, string> {
  // The labels column arrives as a JSON object per row; tolerate a JSON
  // string too, since that's how a frame encodes a json field in some
  // serializations.
  let obj = value;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

/**
 * Parses Grafana's log-lines frames into lines. Two layouts exist and both are
 * handled by field *name*, not position:
 *
 * - **Legacy:** `labels` (json), `Time` (time), `Line` (string), `tsNs`
 *   (string), optionally `labelTypes`, then `id`.
 * - **Dataplane** (behind Grafana's `lokiLogsDataplane` toggle): `labels`,
 *   `timestamp` (time), `body` (string), `id`, optionally `labelTypes`.
 *
 * A frame with a numeric field is a metric result, and a frame with no
 * recognizable line field is a layout this doesn't know — both are refused
 * rather than read as "no lines", since an empty result is exactly what a
 * misread would look like.
 *
 * Lines come back **newest first**, sorted here. Loki applies the limit to the
 * newest lines overall, but Grafana then groups a frame's rows by stream, so
 * they don't arrive in time order. The sort key is the nanosecond timestamp:
 * the legacy layout's `tsNs` column, otherwise the time column's epoch ms plus
 * the frame's `data.nanos` offset for that row. The plugin SDK leaves `nanos`
 * out when every offset is zero, so a missing one means exact milliseconds.
 */
export function parseLokiLogFrames(frames: GrafanaFrame[]): LokiLine[] {
  const lines: Array<{ line: LokiLine; sortNs: bigint | undefined }> = [];
  for (const frame of frames) {
    const fields = frame.schema.fields;
    if (fields.some((f) => f.type === 'number')) {
      throw new Error(
        'Loki returned numeric series rather than log lines — this is a metric query\'s result. search_logs ' +
          'takes a log query (a stream selector plus any pipeline).',
      );
    }
    const timeIdx = fields.findIndex((f) => f.type === 'time');
    const lineIdx = fields.findIndex((f) => f.type === 'string' && /^(line|body)$/i.test(f.name));
    if (timeIdx === -1 || lineIdx === -1) {
      throw new Error(
        `Unrecognized Loki log frame (fields: ${fields.map((f) => `${f.name}:${f.type}`).join(', ')}) — refusing ` +
          'to guess which column holds the log line.',
      );
    }
    const labelsIdx = fields.findIndex((f) => f.name === 'labels');
    const tsNsIdx = fields.findIndex((f) => f.name === 'tsNs');
    // Older Grafana put one stream per frame, with that stream's labels on the
    // line field itself rather than in a labels column.
    const frameLabels = fields[lineIdx]!.labels ?? {};
    const nanos = frame.data.nanos?.[timeIdx] ?? undefined;

    const times = frame.data.values[timeIdx] ?? [];
    const bodies = frame.data.values[lineIdx] ?? [];
    for (let i = 0; i < times.length; i += 1) {
      const t = times[i];
      const ms = typeof t === 'number' ? t : Date.parse(String(t));
      const timestampNs = nanosecondTimestamp(ms, tsNsIdx === -1 ? undefined : frame.data.values[tsNsIdx]?.[i], nanos?.[i]);
      lines.push({
        line: {
          timestamp: Number.isFinite(ms) ? new Date(ms).toISOString() : String(t),
          ...(timestampNs !== undefined ? { timestampNs } : {}),
          message: String(bodies[i] ?? ''),
          labels: { ...frameLabels, ...(labelsIdx === -1 ? {} : toRecord(frame.data.values[labelsIdx]?.[i])) },
        },
        sortNs: timestampNs === undefined ? undefined : BigInt(timestampNs),
      });
    }
  }
  // Newest first; a line whose time couldn't be read sorts last. Array#sort is
  // stable, so lines at the same nanosecond keep the frame's order.
  lines.sort((a, b) => {
    if (a.sortNs === undefined || b.sortNs === undefined) return a.sortNs === undefined ? (b.sortNs === undefined ? 0 : 1) : -1;
    return a.sortNs === b.sortNs ? 0 : a.sortNs > b.sortNs ? -1 : 1;
  });
  return lines.map((l) => l.line);
}

/**
 * A row's Unix-nanosecond timestamp as a decimal string: the legacy layout's
 * `tsNs` when it has one, otherwise epoch ms plus the `data.nanos` offset.
 * Undefined when neither is readable.
 */
function nanosecondTimestamp(ms: number, tsNs: unknown, nanoOffset: number | undefined): string | undefined {
  if (typeof tsNs === 'string' && /^\d+$/.test(tsNs)) return tsNs;
  if (!Number.isInteger(ms)) return undefined;
  return (BigInt(ms) * 1_000_000n + BigInt(Number.isInteger(nanoOffset) ? nanoOffset! : 0)).toString();
}

/**
 * Runs one guarded LogQL log query over a fixed window. Newest lines first
 * (`backward`, Loki's own default), so a capped search keeps the lines nearest
 * the end of the window — the same end an incident is usually being read from.
 */
export async function searchLoki(client: GrafanaClient, params: LokiSearchParams): Promise<LokiSearchResult> {
  const statement = guardLokiLogQuery(params.query);
  const response: DsQueryResponse = await client.queryDs({
    from: String(params.fromMs),
    to: String(params.toMs),
    queries: [
      {
        refId: 'A',
        datasource: { uid: params.datasourceUid, type: 'loki' },
        expr: statement,
        queryType: 'range',
        // maxLines becomes Loki's `limit`. Always sent: unset, Grafana leaves
        // the limit to the datasource's own setting, which nothing here can see
        // — and a cap nobody can see is what makes "truncated" unknowable.
        maxLines: params.limit,
        direction: 'backward',
        editorMode: 'code',
      },
    ],
  });
  const result = response.results.A;
  if (result?.error) {
    throw new Error(`Loki query failed: ${result.error}`);
  }
  const lines = parseLokiLogFrames(result?.frames ?? []);
  return { statement, lines, truncated: lines.length >= params.limit };
}
