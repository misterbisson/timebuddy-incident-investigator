import { vi } from 'vitest';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { DatasourceInfo, DsQueryRequest, DsQueryResponse, GrafanaFrame } from '../src/grafana/types.js';

export interface FixtureLine {
  t: number;
  /** Nanoseconds past `t`'s millisecond, 0-999999. */
  ns?: number;
  line: string;
  labels: Record<string, string>;
}

/** `l`'s Unix-nanosecond timestamp as a string, the way Loki reports one. */
const tsNs = (l: FixtureLine) => (BigInt(l.t) * 1_000_000n + BigInt(l.ns ?? 0)).toString();

/** Grafana's legacy Loki log-lines frame: labels, Time, Line, tsNs, id. */
export function legacyLogFrame(lines: FixtureLine[]): GrafanaFrame {
  return {
    schema: {
      refId: 'A',
      fields: [
        { name: 'labels', type: 'other' },
        { name: 'Time', type: 'time' },
        { name: 'Line', type: 'string' },
        { name: 'tsNs', type: 'string' },
        { name: 'id', type: 'string' },
      ],
    },
    data: {
      values: [
        lines.map((l) => l.labels),
        lines.map((l) => l.t),
        lines.map((l) => l.line),
        lines.map(tsNs),
        lines.map((_, i) => `id-${i}`),
      ],
    },
  };
}

/**
 * The dataplane layout (Grafana's lokiLogsDataplane toggle): labels, timestamp,
 * body, id. The time column holds epoch ms, and the sub-millisecond part goes
 * in `data.nanos`, indexed by field and left out when every offset is zero —
 * the plugin SDK's frame JSON encoding.
 */
export function dataplaneLogFrame(lines: FixtureLine[]): GrafanaFrame {
  const nanos = lines.map((l) => l.ns ?? 0);
  return {
    schema: {
      refId: 'A',
      fields: [
        { name: 'labels', type: 'other' },
        { name: 'timestamp', type: 'time' },
        { name: 'body', type: 'string' },
        { name: 'id', type: 'string' },
      ],
    },
    data: {
      values: [lines.map((l) => l.labels), lines.map((l) => l.t), lines.map((l) => l.line), lines.map((_, i) => `id-${i}`)],
      ...(nanos.some((n) => n !== 0) ? { nanos: [null, nanos, null, null] } : {}),
    },
  };
}

export const LOKI_DS: DatasourceInfo = { uid: 'logs1', id: 9, name: 'Example-Logs', type: 'loki' };

/**
 * A GrafanaClient whose queryDs answers a Loki log query with the fixture
 * lines for its `expr` (honouring maxLines, newest first like `backward`), or
 * with a Loki error when the expr maps to an Error.
 */
export function fakeLokiClient(opts: {
  linesByExpr?: Record<string, FixtureLine[] | Error>;
  datasources?: DatasourceInfo[];
  labelNames?: string[];
  frame?: (lines: FixtureLine[]) => GrafanaFrame;
}): { client: GrafanaClient; queryDs: ReturnType<typeof vi.fn>; listDatasources: ReturnType<typeof vi.fn> } {
  const queryDs = vi.fn(async (req: DsQueryRequest): Promise<DsQueryResponse> => {
    const q = req.queries[0]!;
    const found = opts.linesByExpr?.[String(q.expr)] ?? [];
    if (found instanceof Error) return { results: { A: { error: found.message } } };
    // Loki applies the limit to the newest lines overall; Grafana then groups
    // the frame's rows by stream, so they don't arrive in time order.
    const newestFirst = [...found].sort((a, b) => b.t - a.t);
    const limited = typeof q.maxLines === 'number' ? newestFirst.slice(0, q.maxLines) : newestFirst;
    const byStream = [...limited].sort((a, b) => JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels)));
    return { results: { A: { frames: [(opts.frame ?? legacyLogFrame)(byStream)] } } };
  });
  const listDatasources = vi.fn(async () => opts.datasources ?? [LOKI_DS]);
  const client = {
    queryDs,
    listDatasources,
    getLokiLabelNames: vi.fn(async () => opts.labelNames ?? []),
  } as unknown as GrafanaClient;
  return { client, queryDs, listDatasources };
}
