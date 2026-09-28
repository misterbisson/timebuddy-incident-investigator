import { vi } from 'vitest';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { DatasourceInfo, DsQueryRequest, DsQueryResponse, GrafanaFrame } from '../src/grafana/types.js';

export interface FixtureLine {
  t: number;
  line: string;
  labels: Record<string, string>;
}

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
        lines.map((l) => `${l.t}000000`),
        lines.map((_, i) => `id-${i}`),
      ],
    },
  };
}

/** The dataplane layout (Grafana's lokiLogsDataplane toggle): labels, timestamp, body, id. */
export function dataplaneLogFrame(lines: FixtureLine[]): GrafanaFrame {
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
}): {
  client: GrafanaClient;
  queryDs: ReturnType<typeof vi.fn>;
  listDatasources: ReturnType<typeof vi.fn>;
  getLokiLabelNames: ReturnType<typeof vi.fn>;
} {
  const queryDs = vi.fn(async (req: DsQueryRequest): Promise<DsQueryResponse> => {
    const q = req.queries[0]!;
    const found = opts.linesByExpr?.[String(q.expr)] ?? [];
    if (found instanceof Error) return { results: { A: { error: found.message } } };
    const newestFirst = [...found].sort((a, b) => b.t - a.t);
    const limited = typeof q.maxLines === 'number' ? newestFirst.slice(0, q.maxLines) : newestFirst;
    return { results: { A: { frames: [(opts.frame ?? legacyLogFrame)(limited)] } } };
  });
  const listDatasources = vi.fn(async () => opts.datasources ?? [LOKI_DS]);
  const getLokiLabelNames = vi.fn(async () => opts.labelNames ?? []);
  const client = { queryDs, listDatasources, getLokiLabelNames } as unknown as GrafanaClient;
  return { client, queryDs, listDatasources, getLokiLabelNames };
}
