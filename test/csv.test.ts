import { describe, expect, it } from 'vitest';
import { buildSeriesColumnNames, frameToCsv, parseCsvLine, seriesToCsv } from '../src/export/csv.js';
import type { QuerySeries } from '../src/query/executor.js';
import type { GrafanaFrame } from '../src/grafana/types.js';

function series(refId: string, labels: Record<string, string>, points: Array<[number, number | null]>): QuerySeries {
  return { refId, labels, points: points.map(([t, v]) => ({ t, v })), pointsTotal: points.length };
}

describe('buildSeriesColumnNames', () => {
  it('uses sorted label key=value pairs when labels are present', () => {
    expect(buildSeriesColumnNames([series('A', { job: 'node', host: 'web1' }, [])])).toEqual(['host=web1,job=node']);
  });

  it('falls back to refId when a series has no labels', () => {
    expect(buildSeriesColumnNames([series('A', {}, [])])).toEqual(['A']);
  });

  it('disambiguates duplicate names with a numbered suffix', () => {
    expect(buildSeriesColumnNames([series('A', {}, []), series('A', {}, [])])).toEqual(['A', 'A (2)']);
  });
});

describe('seriesToCsv', () => {
  it('pivots series into a wide format with a UTC ISO timestamp column', () => {
    const csv = seriesToCsv([series('A', {}, [[0, 1]])]);
    expect(csv).toBe('timestamp,A\r\n1970-01-01T00:00:00.000Z,1\r\n');
  });

  it('outer-joins series sampled at different times, leaving the other column blank', () => {
    const csv = seriesToCsv([series('A', { host: 'a' }, [[0, 1]]), series('B', { host: 'b' }, [[60000, 2]])]);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('timestamp,host=a,host=b');
    expect(lines[1]).toBe('1970-01-01T00:00:00.000Z,1,');
    expect(lines[2]).toBe('1970-01-01T00:01:00.000Z,,2');
  });

  it('renders a null point value as an empty cell', () => {
    const csv = seriesToCsv([series('A', {}, [[0, null]])]);
    expect(csv).toBe('timestamp,A\r\n1970-01-01T00:00:00.000Z,\r\n');
  });

  it('returns just the header row when there are no series', () => {
    expect(seriesToCsv([])).toBe('timestamp\r\n');
  });
});

describe('frameToCsv', () => {
  function frame(fields: GrafanaFrame['schema']['fields'], values: unknown[][]): GrafanaFrame {
    return { schema: { fields }, data: { values } };
  }

  it('exports every field as-is, in schema order, including string/dimension columns', () => {
    const f = frame(
      [
        { name: 'Time', type: 'time' },
        { name: 'host', type: 'string' },
        { name: 'value', type: 'number' },
      ],
      [[0, 60000], ['web1', 'web2'], [1, 2]],
    );
    const csv = frameToCsv(f);
    expect(csv).toBe('Time,host,value\r\n1970-01-01T00:00:00.000Z,web1,1\r\n1970-01-01T00:01:00.000Z,web2,2\r\n');
  });

  it('renders a null cell as empty and preserves boolean/number formatting', () => {
    const f = frame(
      [
        { name: 'ok', type: 'boolean' },
        { name: 'count', type: 'number' },
      ],
      [[true, null], [5, null]],
    );
    expect(frameToCsv(f)).toBe('ok,count\r\ntrue,5\r\n,\r\n');
  });

  it('quotes fields containing commas, quotes, or newlines per RFC 4180', () => {
    const f = frame([{ name: 'label', type: 'string' }], [['a,b', 'say "hi"', 'line1\nline2']]);
    expect(frameToCsv(f)).toBe('label\r\n"a,b"\r\n"say ""hi"""\r\n"line1\nline2"\r\n');
  });

  it('returns just the header row when there are no data rows', () => {
    const f = frame([{ name: 'value', type: 'number' }], [[]]);
    expect(frameToCsv(f)).toBe('value\r\n');
  });
});

describe('parseCsvLine', () => {
  it('splits a plain unquoted row on commas', () => {
    expect(parseCsvLine('Field,Mean,Max')).toEqual(['Field', 'Mean', 'Max']);
  });

  it('unescapes a quoted field, including an embedded comma', () => {
    expect(parseCsvLine('"a,b",c')).toEqual(['a,b', 'c']);
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(parseCsvLine('"say ""hi""",c')).toEqual(['say "hi"', 'c']);
  });
});
