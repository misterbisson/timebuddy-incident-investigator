import { describe, expect, it } from 'vitest';
import { lokiEventLabels } from '../src/logs/lokiAdapter.js';
import { correlateLogs } from '../src/logs/correlate.js';
import { fakeLokiClient } from './lokiFixtures.js';

const T0 = Date.parse('2026-03-01T10:00:00Z');
const line = (message: string, labels: Record<string, string> = { app: 'checkout' }) => ({
  timestamp: '2026-03-01T10:00:00.000Z',
  message,
  labels,
});

describe('lokiEventLabels — the fields | json would extract', () => {
  it('adds top-level JSON fields to the stream labels', () => {
    expect(lokiEventLabels(line('{"request_id":"r1","status":500,"ok":false}'))).toEqual({
      app: 'checkout',
      request_id: 'r1',
      status: '500',
      ok: 'false',
    });
  });

  it('flattens nested objects with "_" and sanitizes key characters, like Loki does', () => {
    expect(lokiEventLabels(line('{"error":{"code":"E42"},"http.method":"GET","2xx":1}'))).toEqual({
      app: 'checkout',
      error_code: 'E42',
      http_method: 'GET',
      _2xx: '1',
    });
  });

  it('suffixes a key that collides with a stream label with _extracted rather than overwriting it', () => {
    expect(lokiEventLabels(line('{"app":"from-the-line"}'))).toEqual({ app: 'checkout', app_extracted: 'from-the-line' });
  });

  it('skips arrays and nulls', () => {
    expect(lokiEventLabels(line('{"tags":["a","b"],"user":null,"k":"v"}'))).toEqual({ app: 'checkout', k: 'v' });
  });

  it('marks a non-JSON line with __error__, as | json does, and extracts nothing from it', () => {
    const failed = { app: 'checkout', __error__: 'JSONParserErr' };
    expect(lokiEventLabels(line('GET /cart 500 request_id=r1'))).toEqual(failed);
    expect(lokiEventLabels(line('["not","an","object"]'))).toEqual(failed);
    expect(lokiEventLabels(line(''))).toEqual(failed);
  });

  // #278: String(JSON.parse(...)) rounds a large integer to a double, so two
  // distinct ids became one join value. Loki keeps the number's source text.
  it('keeps a number\'s source text rather than its parsed value', () => {
    expect(lokiEventLabels(line('{"a":12345678901234567891,"b":12345678901234567890}'))).toMatchObject({
      a: '12345678901234567891',
      b: '12345678901234567890',
    });
    expect(lokiEventLabels(line('{"x":1.0,"y":1e21,"z":-0}'))).toMatchObject({ x: '1.0', y: '1e21', z: '-0' });
  });

  // #278's table, each row checked against Loki's sanitizeLabelKey /
  // appendSanitized (pkg/logql/log/util.go) and its parser tests.
  it.each([
    ['only the first segment of a nested key gets the leading-digit prefix', '{"a":{"1b":"x"}}', { a_1b: 'x' }],
    ['keys are trimmed of whitespace', '{" request_id ":"r1"}', { request_id: 'r1' }],
    ['a non-ASCII character becomes one "_" per code point', '{"a\u{1F600}b":1}', { a_b: '1' }],
    ['an all-whitespace parent key adds no prefix', '{" ": {"foo":"bar"}}', { foo: 'bar' }],
    ['an empty key names no label', '{"":"x","k":"v"}', { k: 'v' }],
  ])('%s', (_name, json, want) => {
    expect(lokiEventLabels(line(json, {}))).toEqual(want);
  });

  // Ported from Loki's own TestJSONParser (pkg/logql/log/parser_test.go, v3.4.0).
  it.each([
    [
      'multi depth',
      '{"app":"foo","namespace":"prod","pod":{"uuid":"foo","deployment":{"ref":"foobar"}}}',
      {},
      { app: 'foo', namespace: 'prod', pod_uuid: 'foo', pod_deployment_ref: 'foobar' },
    ],
    ['numeric', '{"counter":1, "price": {"_net_":5.56909}}', {}, { counter: '1', price__net_: '5.56909' }],
    ['escaped', '{"counter":1,"foo":"foo\\\\\\"bar", "price": {"_net_":5.56909}}', {}, { counter: '1', foo: 'foo\\"bar', price__net_: '5.56909' }],
    ['skip arrays', '{"counter":1, "price": {"net_":["10","20"]}}', {}, { counter: '1' }],
    ['bad key replaced', '{"cou-nter":1}', {}, { cou_nter: '1' }],
    ['errors', '{n}', {}, { __error__: 'JSONParserErr' }],
    [
      'duplicate extraction',
      '{"app":"foo","namespace":"prod","pod":{"uuid":"foo","deployment":{"ref":"foobar"}},"next":{"err":false}}',
      { app: 'bar' },
      { app: 'bar', app_extracted: 'foo', namespace: 'prod', pod_uuid: 'foo', pod_deployment_ref: 'foobar', next_err: 'false' },
    ],
  ])('matches Loki\'s "%s" case', (_name, json, stream, want) => {
    expect(lokiEventLabels(line(json, stream))).toEqual(want);
  });

  it('skips brackets and braces inside strings when finding where an array or object ends', () => {
    expect(lokiEventLabels(line('{"a":["]","{"],"b":{"c":"}"},"d":"e"}', {}))).toEqual({ b_c: '}', d: 'e' });
  });

  it('suffixes a nested name that collides with a stream label too', () => {
    expect(lokiEventLabels(line('{"pod":{"uuid":"x"}}', { pod_uuid: 'y' }))).toEqual({ pod_uuid: 'y', pod_uuid_extracted: 'x' });
  });

  it('replaces U+FFFD in a value with a space, as Loki does', () => {
    expect(lokiEventLabels(line('{"foo":"a\\uFFFDb"}', {}))).toEqual({ foo: 'a b' });
  });

  // #278: `key in labels` walked the prototype chain, and assigning
  // "__proto__" set the prototype instead of a label.
  it('treats constructor, toString, and __proto__ as ordinary keys', () => {
    const labels = lokiEventLabels(line('{"constructor":"c","toString":"t","__proto__":"p"}', {}));
    expect(Object.keys(labels).sort()).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.getOwnPropertyDescriptor(labels, '__proto__')?.value).toBe('p');
    expect(labels.constructor).toBe('c');
  });

  it('does not suffix a key whose name only exists on Object.prototype', () => {
    expect(lokiEventLabels(line('{"constructor":"c"}'))).toEqual({ app: 'checkout', constructor: 'c' });
  });

  // #278: Loki's ObjectEach extracts a clipped line's leading fields before it
  // fails, so a line cut off after its request id still joins in Loki's view.
  it('extracts the leading fields of a truncated line and marks it with __error__', () => {
    expect(lokiEventLabels(line('{"request_id":"r1","msg":"cut of'))).toEqual({
      app: 'checkout',
      request_id: 'r1',
      __error__: 'JSONParserErr',
    });
  });

  it('extracts nothing from an unterminated nested object, since Loki finds its end before reading it', () => {
    expect(lokiEventLabels(line('{"a":"1","b":{"c":"2"', {}))).toEqual({ a: '1', __error__: 'JSONParserErr' });
  });

  it('does not reach into a JSON payload double-encoded inside a string field', () => {
    // In Loki that takes line_format + a second | json, which the join grammar
    // can't express — search_logs is the tool for that shape.
    expect(lokiEventLabels(line('{"payload":"{\\"request_id\\":\\"r1\\"}"}'))).toEqual({ app: 'checkout', payload: '{"request_id":"r1"}' });
  });

  // #284 review, each row checked against Loki v3.7.8's JSONParser: when two
  // fields land on one label name, Loki keeps the first (parseLabelValue skips
  // a name ParserLabelHints().Extracted already has).
  it.each([
    ['two keys that sanitize to one name', '{"request_id":"r1","request-id":"r2"}', {}, { request_id: 'r1' }],
    ['a repeated key', '{"k":"first","k":"second"}', {}, { k: 'first' }],
    ['a dotted key and the nested path it spells', '{"a.b":"x","a":{"b":"y"}}', {}, { a_b: 'x' }],
    ['a suffixed collision and a key already named that', '{"app":"x","app_extracted":"y"}', { app: 'checkout' }, { app: 'checkout', app_extracted: 'x' }],
  ])('keeps the first value for %s', (_name, json, stream, want) => {
    expect(lokiEventLabels(line(json, stream))).toEqual(want);
  });

  // #284 review: jsonparser accepts raw control characters inside a string;
  // JSON.parse rejects them.
  it('keeps a raw tab or newline inside a string value', () => {
    expect(lokiEventLabels(line('{"msg":"a\tb","k":"v"}', {}))).toEqual({ msg: 'a\tb', k: 'v' });
    expect(lokiEventLabels(line('{"msg":"line1\nline2","request_id":"r1"}', {}))).toEqual({ msg: 'line1\nline2', request_id: 'r1' });
  });

  it('reads a key containing a raw tab', () => {
    expect(lokiEventLabels(line('{"a\tb":"x","k":"v"}', {}))).toEqual({ a_b: 'x', k: 'v' });
  });

  it('gives a value with a lone surrogate escape "", as Loki does, and keeps the line\'s other fields', () => {
    expect(lokiEventLabels(line('{"a":"\\ud800","k":"v"}', {}))).toEqual({ a: '', k: 'v' });
  });

  it('decodes a surrogate pair escape', () => {
    expect(lokiEventLabels(line('{"a":"\\ud83d\\ude00"}', {}))).toEqual({ a: '\u{1F600}' });
  });

  it('treats an unknown escape in a value as "", and in a key as a parse error', () => {
    expect(lokiEventLabels(line('{"a":"x\\qy","k":"v"}', {}))).toEqual({ a: '', k: 'v' });
    expect(lokiEventLabels(line('{"k":"v","b\\q":"x","c":"y"}', {}))).toEqual({ k: 'v', __error__: 'JSONParserErr' });
  });

  // #284 review: Loki parses a nested object inside the span blockEnd found,
  // then resumes the outer walk after that span.
  it('resumes after a malformed nested object where Loki does', () => {
    expect(lokiEventLabels(line('{"x":{"a":1{},"b":2},"c":3}', {}))).toEqual({ x_a: '1{', c: '3' });
  });

  it('skips an empty or whitespace nested key segment, adding no "_" for it', () => {
    expect(lokiEventLabels(line('{"a":{" ":{"b":"x"}}}', {}))).toEqual({ a_b: 'x' });
    expect(lokiEventLabels(line('{" ":{"1b":"x"}}', {}))).toEqual({ _1b: 'x' });
  });

  it('accepts a trailing comma, as jsonparser\'s ObjectEach does', () => {
    expect(lokiEventLabels(line('{"a":1,}', {}))).toEqual({ a: '1' });
  });

  it('reads "undefined" as an error, like any unknown literal', () => {
    expect(lokiEventLabels(line('{"k":"v","u":undefined}', {}))).toEqual({ k: 'v', __error__: 'JSONParserErr' });
  });

  // #284 review: ~5000 levels overflowed the stack, and the RangeError aborted
  // the whole correlate_logs call.
  it('marks a pathologically deep line as a parse error instead of throwing', () => {
    const deep = `{"k":"v","d":${'{"a":'.repeat(20_000)}1${'}'.repeat(20_000)}}`;
    expect(lokiEventLabels(line(deep, {}))).toEqual({ k: 'v', __error__: 'JSONParserErr' });
  });

  // #284 review: Go's unicode.IsSpace and String#trim disagree on U+FEFF and U+0085.
  it('trims keys with Go\'s whitespace set, not JavaScript\'s', () => {
    expect(lokiEventLabels(line('{"\u{FEFF}id":"x"}', {}))).toEqual({ _id: 'x' });
    expect(lokiEventLabels(line('{"id\u{0085}":"x"}', {}))).toEqual({ id: 'x' });
  });

  it('drops a name that is empty only because every nested segment was blank (Loki emits "")', () => {
    expect(lokiEventLabels(line('{" ":{" ":"bar"},"k":"v"}', {}))).toEqual({ k: 'v' });
  });
});

describe('correlateLogs against a Loki source', () => {
  // #284 review: last-wins here made this join empty; Loki joins r1.
  it('joins on the first of two fields that sanitize to the join key', async () => {
    const front = [{ t: T0, line: '{"request_id":"r1"}', labels: { app: 'frontend' } }];
    const back = [{ t: T0 + 500, line: '{"request_id":"r1","request.id":"r2"}', labels: { app: 'backend' } }];
    const { client } = fakeLokiClient({ linesByExpr: { '{app="frontend"}': front, '{app="backend"}': back } });
    const { events } = await correlateLogs({
      target: { sourceType: 'loki', client, datasourceUid: 'logs1' },
      query: 'loki({app="frontend"})[5m] and on(request_id) loki({app="backend"})[5m]',
      fromMs: T0,
      toMs: T0 + 60_000,
      limit: 100,
    });
    expect(events.map((e) => e.joinValue)).toEqual(['r1']);
  });

  // #278: both ids rounded to 12345678901234567000, so the anti-join found a
  // backend line for a request that never reached the backend.
  it('keeps large numeric ids distinct through an unless join', async () => {
    const front = [
      { t: T0, line: '{"request_id":12345678901234567891}', labels: { app: 'frontend' } },
      { t: T0 + 1000, line: '{"request_id":12345678901234567890}', labels: { app: 'frontend' } },
    ];
    const back = [{ t: T0 + 500, line: '{"request_id":12345678901234567890}', labels: { app: 'backend' } }];
    const { client } = fakeLokiClient({ linesByExpr: { '{app="frontend"}': front, '{app="backend"}': back } });
    const { events } = await correlateLogs({
      target: { sourceType: 'loki', client, datasourceUid: 'logs1' },
      query: 'loki({app="frontend"})[5m] unless on(request_id) loki({app="backend"})[5m]',
      fromMs: T0,
      toMs: T0 + 60_000,
      limit: 100,
    });
    expect(events.map((e) => e.joinValue)).toEqual(['12345678901234567891']);
  });

  const front = [
    { t: T0, line: '{"request_id":"r1","path":"/cart"}', labels: { app: 'frontend' } },
    { t: T0 + 1000, line: '{"request_id":"r2","path":"/pay"}', labels: { app: 'frontend' } },
  ];
  const back = [{ t: T0 + 500, line: '{"request_id":"r1","status":500}', labels: { app: 'backend' } }];

  it('joins on a field extracted from JSON lines, through the real engine', async () => {
    const { client, queryDs } = fakeLokiClient({ linesByExpr: { '{app="frontend"}': front, '{app="backend"}': back } });
    const { events, streams } = await correlateLogs({
      target: { sourceType: 'loki', client, datasourceUid: 'logs1' },
      query: 'loki({app="frontend"})[5m] and on(request_id) loki({app="backend"})[5m]',
      fromMs: T0,
      toMs: T0 + 60_000,
      limit: 100,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.joinValue).toBe('r1');
    expect(events[0]?.metadata.completeness).toBe('complete');
    expect(streams).toEqual([
      { selector: '{app="frontend"}', fetched: 2, truncated: false },
      { selector: '{app="backend"}', fetched: 1, truncated: false },
    ]);
    // Every side ran against the fixed window, not a live tail.
    for (const [req] of queryDs.mock.calls) {
      expect([req.from, req.to]).toEqual([String(T0), String(T0 + 60_000)]);
    }
  });

  it('answers an anti-join ("unless") from extracted fields', async () => {
    const { client } = fakeLokiClient({ linesByExpr: { '{app="frontend"}': front, '{app="backend"}': back } });
    const { events } = await correlateLogs({
      target: { sourceType: 'loki', client, datasourceUid: 'logs1' },
      query: 'loki({app="frontend"})[5m] unless on(request_id) loki({app="backend"})[5m]',
      fromMs: T0,
      toMs: T0 + 60_000,
      limit: 100,
    });
    expect(events.map((e) => e.joinValue)).toEqual(['r2']);
  });

  it('marks a stream that hit the cap as truncated, with no total', async () => {
    const { client } = fakeLokiClient({ linesByExpr: { '{app="frontend"}': front, '{app="backend"}': back } });
    const { streams } = await correlateLogs({
      target: { sourceType: 'loki', client, datasourceUid: 'logs1' },
      query: 'loki({app="frontend"})[5m] and on(request_id) loki({app="backend"})[5m]',
      fromMs: T0,
      toMs: T0 + 60_000,
      limit: 1,
    });
    expect(streams[0]).toEqual({ selector: '{app="frontend"}', fetched: 1, truncated: true });
  });
});
