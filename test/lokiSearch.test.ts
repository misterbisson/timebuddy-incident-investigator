import { describe, expect, it } from 'vitest';
import { guardLokiLogQuery, parseLokiLogFrames, searchLoki } from '../src/logs/loki.js';
import { dataplaneLogFrame, fakeLokiClient, legacyLogFrame } from './lokiFixtures.js';

const T0 = Date.parse('2026-03-01T10:00:00Z');

describe('parseLokiLogFrames', () => {
  const lines = [
    { t: T0, line: 'GET /cart 500', labels: { app: 'checkout', level: 'error' } },
    { t: T0 + 1000, line: 'GET /cart 200', labels: { app: 'checkout', level: 'info' } },
  ];

  it('reads the legacy layout (labels, Time, Line, tsNs, id)', () => {
    expect(parseLokiLogFrames([legacyLogFrame(lines)])).toEqual([
      { timestamp: '2026-03-01T10:00:01.000Z', timestampNs: `${T0 + 1000}000000`, message: 'GET /cart 200', labels: { app: 'checkout', level: 'info' } },
      { timestamp: '2026-03-01T10:00:00.000Z', timestampNs: `${T0}000000`, message: 'GET /cart 500', labels: { app: 'checkout', level: 'error' } },
    ]);
  });

  it('reads the dataplane layout (labels, timestamp, body, id) the same way', () => {
    const parsed = parseLokiLogFrames([dataplaneLogFrame(lines)]);
    expect(parsed.map((l) => [l.timestamp, l.timestampNs, l.message, l.labels.level])).toEqual([
      ['2026-03-01T10:00:01.000Z', `${T0 + 1000}000000`, 'GET /cart 200', 'info'],
      ['2026-03-01T10:00:00.000Z', `${T0}000000`, 'GET /cart 500', 'error'],
    ]);
  });

  // #280: Grafana groups a frame's rows by stream, so they arrive out of time
  // order (its own v11.3 streams_simple golden frame does). The shape here is
  // that one's: two streams, each in its own order.
  const grouped = [
    { t: T0 + 3000, ns: 120_500, line: 'a3', labels: { app: 'a' } },
    { t: T0 + 1000, ns: 0, line: 'a1', labels: { app: 'a' } },
    { t: T0 + 3000, ns: 900_000, line: 'b3', labels: { app: 'b' } },
    { t: T0 + 2000, ns: 5, line: 'b2', labels: { app: 'b' } },
  ];
  const newestFirst = ['b3', 'a3', 'b2', 'a1'];

  it('returns dataplane lines newest first, ordering within a millisecond by the frame\'s nanos', () => {
    const frame = dataplaneLogFrame(grouped);
    expect(frame.data.nanos).toEqual([null, [120_500, 0, 900_000, 5], null, null]);
    const parsed = parseLokiLogFrames([frame]);
    expect(parsed.map((l) => l.message)).toEqual(newestFirst);
    expect(parsed.map((l) => l.timestampNs)).toEqual([
      `${T0 + 3000}900000`,
      `${T0 + 3000}120500`,
      `${T0 + 2000}000005`,
      `${T0 + 1000}000000`,
    ]);
  });

  it('returns legacy lines newest first by tsNs', () => {
    expect(parseLokiLogFrames([legacyLogFrame(grouped)]).map((l) => l.message)).toEqual(newestFirst);
  });

  it('orders across frames too (older Grafana sent one frame per stream)', () => {
    const [a, b] = [grouped.filter((l) => l.labels.app === 'a'), grouped.filter((l) => l.labels.app === 'b')];
    expect(parseLokiLogFrames([dataplaneLogFrame(a), legacyLogFrame(b)]).map((l) => l.message)).toEqual(newestFirst);
  });

  it('takes per-stream labels from the line field when there is no labels column (older Grafana)', () => {
    const frame = {
      schema: {
        fields: [
          { name: 'ts', type: 'time' },
          { name: 'line', type: 'string', labels: { app: 'checkout' } },
        ],
      },
      data: { values: [[T0], ['hello']] },
    };
    expect(parseLokiLogFrames([frame])).toEqual([
      { timestamp: '2026-03-01T10:00:00.000Z', timestampNs: `${T0}000000`, message: 'hello', labels: { app: 'checkout' } },
    ]);
  });

  it('refuses a numeric frame (a metric query result) rather than returning no lines', () => {
    const frame = { schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number' }] }, data: { values: [[T0], [3]] } };
    expect(() => parseLokiLogFrames([frame])).toThrow(/numeric series rather than log lines/);
  });

  it('refuses a frame layout it does not recognize rather than guessing the line column', () => {
    const frame = { schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'text', type: 'string' }] }, data: { values: [[T0], ['x']] } };
    expect(() => parseLokiLogFrames([frame])).toThrow(/Unrecognized Loki log frame/);
  });
});

describe('guardLokiLogQuery', () => {
  it('passes a log query through verbatim, pipeline and all', () => {
    const q = '{app=~"checkout|cart", namespace="shop"} |= `POST` | json | line_format `{{.payload}}` |~ `"status":"(500|503|timeout)"`';
    expect(guardLokiLogQuery(`  ${q} `)).toBe(q);
  });

  it('refuses a metric query and points at execute_adhoc_query', () => {
    expect(() => guardLokiLogQuery('sum(count_over_time({app="x"}[1m]))')).toThrow(/metric query.*execute_adhoc_query/s);
  });

  it('refuses a structurally broken query with the guard\'s reason', () => {
    expect(() => guardLokiLogQuery('{app="x"')).toThrow(/LogQL query refused: .*unbalanced brackets/);
  });
});

describe('searchLoki', () => {
  const lines = Array.from({ length: 5 }, (_, i) => ({ t: T0 + i * 1000, line: `line ${i}`, labels: { app: 'checkout' } }));

  it('sends a range log query with an explicit line cap, newest first, to the Loki datasource', async () => {
    const { client, queryDs } = fakeLokiClient({ linesByExpr: { '{app="checkout"}': lines } });
    await searchLoki(client, { datasourceUid: 'logs1', query: '{app="checkout"}', fromMs: T0, toMs: T0 + 60_000, limit: 100 });
    const req = queryDs.mock.calls[0]![0];
    expect(req.from).toBe(String(T0));
    expect(req.to).toBe(String(T0 + 60_000));
    expect(req.queries[0]).toEqual({
      refId: 'A',
      datasource: { uid: 'logs1', type: 'loki' },
      expr: '{app="checkout"}',
      queryType: 'range',
      maxLines: 100,
      direction: 'backward',
      editorMode: 'code',
    });
  });

  it('is not truncated below the cap, and is at it — Loki gives no total to compare against', async () => {
    const { client } = fakeLokiClient({ linesByExpr: { '{app="checkout"}': lines } });
    const under = await searchLoki(client, { datasourceUid: 'logs1', query: '{app="checkout"}', fromMs: T0, toMs: T0 + 1, limit: 10 });
    expect(under.lines).toHaveLength(5);
    expect(under.truncated).toBe(false);
    const at = await searchLoki(client, { datasourceUid: 'logs1', query: '{app="checkout"}', fromMs: T0, toMs: T0 + 1, limit: 3 });
    expect(at.lines.map((l) => l.message)).toEqual(['line 4', 'line 3', 'line 2']);
    expect(at.truncated).toBe(true);
  });

  it('surfaces a Loki error instead of returning an empty result', async () => {
    const { client } = fakeLokiClient({ linesByExpr: { '{app="checkout"}': new Error('parse error at line 1, col 5') } });
    await expect(
      searchLoki(client, { datasourceUid: 'logs1', query: '{app="checkout"}', fromMs: T0, toMs: T0 + 1, limit: 10 }),
    ).rejects.toThrow(/Loki query failed: parse error/);
  });

  it('never reaches the datasource for a refused query', async () => {
    const { client, queryDs } = fakeLokiClient({});
    await expect(
      searchLoki(client, { datasourceUid: 'logs1', query: 'rate({app="x"}[1m])', fromMs: T0, toMs: T0 + 1, limit: 10 }),
    ).rejects.toThrow(/metric query/);
    expect(queryDs).not.toHaveBeenCalled();
  });
});
