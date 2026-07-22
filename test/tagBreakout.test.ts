import { describe, expect, it } from 'vitest';
import { applyTagBreakout, TagBreakoutError } from '../src/dashboards/tagBreakout.js';
import type { ResolvedTarget } from '../src/dashboards/panelQueries.js';
import type { PanelTarget } from '../src/grafana/types.js';

function target(raw: Partial<PanelTarget>): ResolvedTarget {
  return { refId: raw.refId ?? 'A', datasourceUid: 'influx1', raw: { refId: raw.refId ?? 'A', ...raw } };
}

describe('applyTagBreakout — filter (value present)', () => {
  it('appends a "key = value" tag filter to a builder-mode target with no existing tags', () => {
    const out = applyTagBreakout(target({ measurement: 'cpu_load' }), { key: 'host', value: 'web-07' });
    expect(out.raw.tags).toEqual([{ key: 'host', operator: '=', value: 'web-07' }]);
  });

  it('appends with an AND condition when the target already has a tag constraint', () => {
    const out = applyTagBreakout(
      target({ measurement: 'cpu_load', tags: [{ key: 'region', operator: '=', value: 'us-east' }] }),
      { key: 'host', value: 'web-07' },
    );
    expect(out.raw.tags).toEqual([
      { key: 'region', operator: '=', value: 'us-east' },
      { key: 'host', operator: '=', value: 'web-07', condition: 'AND' },
    ]);
  });

  it('passes the raw host value through unescaped — Grafana builds & escapes the query from the structured field', () => {
    const out = applyTagBreakout(target({ measurement: 'cpu_load' }), { key: 'host', value: "o'brien-01" });
    expect(out.raw.tags).toEqual([{ key: 'host', operator: '=', value: "o'brien-01" }]);
  });

  it('is idempotent — re-applying the same exact filter does not duplicate the clause', () => {
    const once = applyTagBreakout(target({ measurement: 'cpu_load' }), { key: 'host', value: 'web-07' });
    const twice = applyTagBreakout({ ...once }, { key: 'host', value: 'web-07' });
    expect(twice.raw.tags).toEqual([{ key: 'host', operator: '=', value: 'web-07' }]);
  });

  it('filters to an empty string value when value is "" (presence, not truthiness, selects filter mode)', () => {
    const out = applyTagBreakout(target({ measurement: 'cpu_load', groupBy: [] }), { key: 'host', value: '' });
    expect(out.raw.tags).toEqual([{ key: 'host', operator: '=', value: '' }]);
    expect(out.raw.groupBy).toEqual([]); // untouched — not the group-by path
  });

  it('does not mutate the input target', () => {
    const input = target({ measurement: 'cpu_load', tags: [{ key: 'region', operator: '=', value: 'us-east' }] });
    applyTagBreakout(input, { key: 'host', value: 'web-07' });
    expect(input.raw.tags).toEqual([{ key: 'region', operator: '=', value: 'us-east' }]);
  });
});

describe('applyTagBreakout — group by (value omitted)', () => {
  it('appends a tag group-by part to a flat groupBy that has only a time part', () => {
    const out = applyTagBreakout(
      target({ measurement: 'cpu_load', groupBy: [{ type: 'time', params: ['$__interval'] }] }),
      { key: 'host' },
    );
    expect(out.raw.groupBy).toEqual([
      { type: 'time', params: ['$__interval'] },
      { type: 'tag', params: ['host'] },
    ]);
  });

  it('inserts the tag part BEFORE a fill part (InfluxQL requires fill last)', () => {
    const out = applyTagBreakout(
      target({ measurement: 'cpu_load', groupBy: [{ type: 'time', params: ['$__interval'] }, { type: 'fill', params: ['null'] }] }),
      { key: 'host' },
    );
    expect(out.raw.groupBy).toEqual([
      { type: 'time', params: ['$__interval'] },
      { type: 'tag', params: ['host'] },
      { type: 'fill', params: ['null'] },
    ]);
  });

  it('matches the existing element shape when groupBy is nested (array-of-arrays)', () => {
    const out = applyTagBreakout(
      target({ measurement: 'cpu_load', groupBy: [[{ type: 'time', params: ['$__interval'] }], [{ type: 'fill', params: ['null'] }]] }),
      { key: 'host' },
    );
    expect(out.raw.groupBy).toEqual([
      [{ type: 'time', params: ['$__interval'] }],
      [{ type: 'tag', params: ['host'] }],
      [{ type: 'fill', params: ['null'] }],
    ]);
  });

  it('creates a flat groupBy when the target has none', () => {
    const out = applyTagBreakout(target({ measurement: 'cpu_load' }), { key: 'host' });
    expect(out.raw.groupBy).toEqual([{ type: 'tag', params: ['host'] }]);
  });

  it('is idempotent — grouping by a key already grouped on is a no-op (flat)', () => {
    const out = applyTagBreakout(
      target({ measurement: 'cpu_load', groupBy: [{ type: 'time', params: ['$__interval'] }, { type: 'tag', params: ['host'] }] }),
      { key: 'host' },
    );
    expect(out.raw.groupBy).toEqual([
      { type: 'time', params: ['$__interval'] },
      { type: 'tag', params: ['host'] },
    ]);
  });

  it('is idempotent when the existing tag group-by is nested', () => {
    const out = applyTagBreakout(
      target({ measurement: 'cpu_load', groupBy: [[{ type: 'tag', params: ['host'] }]] }),
      { key: 'host' },
    );
    expect(out.raw.groupBy).toEqual([[{ type: 'tag', params: ['host'] }]]);
  });

  it('does not mutate the input target', () => {
    const input = target({ measurement: 'cpu_load', groupBy: [{ type: 'time', params: ['$__interval'] }] });
    applyTagBreakout(input, { key: 'host' });
    expect(input.raw.groupBy).toEqual([{ type: 'time', params: ['$__interval'] }]);
  });
});

describe('applyTagBreakout — unsupported targets hard-error (never silent no-op)', () => {
  it('throws for a raw-mode InfluxQL target (rawQuery: true)', () => {
    const t = target({ measurement: 'cpu_load', query: 'SELECT mean("v") FROM "cpu_load"', rawQuery: true });
    expect(() => applyTagBreakout(t, { key: 'host' })).toThrow(TagBreakoutError);
    expect(() => applyTagBreakout(t, { key: 'host' })).toThrow(/rawQuery: true/);
  });

  it('throws for a target whose rawQuery is a truthy non-boolean (e.g. "true") even with a measurement', () => {
    // A non-standard dashboard JSON could store rawQuery as a string; guarding
    // on `=== true` would silently mutate fields Grafana ignores while it runs
    // the raw query. Any truthy rawQuery must be treated as raw mode.
    const t = target({ measurement: 'cpu_load', query: 'SELECT mean("v")', rawQuery: 'true' as unknown as boolean });
    expect(() => applyTagBreakout(t, { key: 'host' })).toThrow(TagBreakoutError);
  });

  it('throws for a Prometheus target (has expr), pointing at issue #127', () => {
    const t = target({ expr: 'sum(rate(http_requests_total[5m]))' });
    expect(() => applyTagBreakout(t, { key: 'instance' })).toThrow(/#127/);
  });

  it('throws when neither a builder measurement nor a PromQL expr is present', () => {
    const t = target({ query: 'SELECT 1', rawQuery: false });
    expect(() => applyTagBreakout(t, { key: 'host' })).toThrow(/couldn't identify a supported query type/);
  });

  it('names the offending refId in the error', () => {
    const t = target({ refId: 'B', expr: 'up' });
    expect(() => applyTagBreakout(t, { key: 'host' })).toThrow(/refId B/);
  });
});
