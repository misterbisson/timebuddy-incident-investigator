import { describe, expect, it } from 'vitest';
import {
  approximateResolution,
  buildSeriesColumnNames,
  frameToCsv,
  neutralizeCsvDocument,
  parseCsv,
  parseCsvLine,
  resolutionFromTimestamps,
  seriesToCsv,
} from '../src/export/csv.js';
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

describe('spreadsheet formula neutralization', () => {
  const cells = (values: string[]): GrafanaFrame =>
    ({ schema: { fields: [{ name: 'label', type: 'string' }] }, data: { values: [values] } }) as GrafanaFrame;
  const rows = (f: GrafanaFrame) => frameToCsv(f).trimEnd().split('\r\n');

  // The reported vector: a leading = is executed on open by Excel,
  // LibreOffice, and Sheets. RFC 4180 quoting is not a defense — Excel
  // evaluates a quoted field's contents just the same.
  it('neutralizes each formula lead character', () => {
    expect(rows(cells(['=cmd|\' /C calc\'!A0', '+1+1', '@SUM(A1)', '-2+3']))).toEqual([
      'label',
      "'=cmd|' /C calc'!A0",
      "'+1+1",
      "'@SUM(A1)",
      "'-2+3",
    ]);
  });

  it('neutralizes a leading tab or CR, which spreadsheets strip before the formula check', () => {
    // A tab needs no RFC 4180 quoting (it isn't a delimiter here); a CR does.
    expect(rows(cells(['\t=1+1']))[1]).toBe("'\t=1+1");
    expect(frameToCsv(cells(['\r=1+1']))).toContain('"\'\r=1+1"');
  });

  // Load-bearing: negative numbers reach escapeCsvField as strings via
  // formatCell's String(...), and mangling them into text would break the
  // numeric analysis this export exists to enable.
  it('leaves negative and signed numbers untouched', () => {
    expect(rows(cells(['-1.5', '-0.5', '+2', '-1e3', '-.5', '-0']))).toEqual([
      'label',
      '-1.5',
      '-0.5',
      '+2',
      '-1e3',
      '-.5',
      '-0',
    ]);
  });

  it('neutralizes something that only looks numeric', () => {
    expect(rows(cells(['-1.5x', '-', '-1-1', '- 1']))).toEqual(['label', "'-1.5x", "'-", "'-1-1", "'- 1"]);
  });

  it('leaves ordinary text alone, including an = that is not in the leading position', () => {
    expect(rows(cells(['web1', 'up', 'a=b']))).toEqual(['label', 'web1', 'up', 'a=b']);
  });

  it('puts the apostrophe inside the quotes when the cell also needs RFC 4180 escaping', () => {
    expect(rows(cells(['=a,b', '=say "hi"']))).toEqual(['label', '"\'=a,b"', '"\'=say ""hi"""']);
  });

  // Column names derive from Grafana-supplied refId/label values, so the
  // header row is an injection vector too, not just the data rows.
  it('neutralizes a formula in a column header, not just in cells', () => {
    const f = { schema: { fields: [{ name: '=cmd|\' /C calc\'!A0', type: 'string' }] }, data: { values: [[]] } } as GrafanaFrame;
    expect(frameToCsv(f)).toBe("'=cmd|' /C calc'!A0\r\n");
  });

  // The issue's own example. seriesColumnName falls back to refId when a
  // series has no labels, so a hostile refId lands in the leading position of
  // a header cell — where a label *value* never can, since it's always
  // preceded by "key=".
  it('neutralizes a seriesToCsv column name taken from a hostile refId', () => {
    const csv = seriesToCsv([series("=cmd|' /C calc'!A0", {}, [[0, 1]])]);
    // No RFC 4180 quoting here: the payload's quotes are single, not double,
    // and it has no comma or newline — which is precisely why quoting was
    // never the defense against this.
    expect(csv.split('\r\n')[0]).toBe("timestamp,'=cmd|' /C calc'!A0");
  });

  it('neutralizes a column name whose leading label key starts with a formula character', () => {
    const csv = seriesToCsv([series('A', { '=x': 'web1' }, [[0, 1]])]);
    expect(csv.split('\r\n')[0]).toBe("timestamp,'=x=web1");
  });

  it('does not mangle seriesToCsv numeric data, including negatives', () => {
    const csv = seriesToCsv([series('A', {}, [[0, -1.5]])]);
    expect(csv.split('\r\n')[1]).toBe('1970-01-01T00:00:00.000Z,-1.5');
  });
});

describe('formula neutralization edge cases the first pass missed', () => {
  const cells = (values: string[]): GrafanaFrame =>
    ({ schema: { fields: [{ name: 'label', type: 'string' }] }, data: { values: [values] } }) as GrafanaFrame;
  const rows = (f: GrafanaFrame) => frameToCsv(f).trimEnd().split('\r\n');

  // LF was reachable by the docstring's own logic (spreadsheets strip it
  // before the formula check, exactly like tab and CR) but wasn't in the
  // trigger set, so "\n=1+1" shipped quoted-but-live.
  it('neutralizes every leading whitespace character that a spreadsheet strips', () => {
    for (const ws of ['\t', '\r', '\n', '\v', '\f']) {
      const csv = frameToCsv(cells([`${ws}=1+1`]));
      expect(csv, `leading ${JSON.stringify(ws)}`).toContain(`'${ws}=1+1`);
    }
  });

  // Still neutralized when a whole *run* of stripped whitespace precedes the
  // formula — the smuggling works the same whether it's one char or several.
  it('neutralizes a run of stripped whitespace ahead of a formula character', () => {
    expect(frameToCsv(cells(['\t\t=1+1']))).toContain("'\t\t=1+1");
    expect(frameToCsv(cells(['\r\n@SUM(A1)']))).toContain("'\r\n@SUM(A1)");
  });

  // Issue #106: the previous trigger set matched *any* leading control-
  // whitespace, so a cell that begins with a tab/newline and then ordinary
  // text got a spurious apostrophe. Whitespace only smuggles when a formula
  // character actually follows it; text behind it is just text.
  it('leaves leading stripped whitespace alone when ordinary text follows, not a formula', () => {
    // No RFC 4180 quoting needed (tab is not a delimiter), and crucially no
    // leading apostrophe — the whole point of the fix.
    expect(frameToCsv(cells(['\tHello']))).toBe('label\r\n\tHello\r\n');
    // A bare LF still forces RFC 4180 quoting, but not neutralization.
    expect(frameToCsv(cells(['\nfoo']))).toBe('label\r\n"\nfoo"\r\n');
    // A multi-char whitespace run followed by text is equally untouched.
    expect(frameToCsv(cells(['\t\tplain']))).toBe('label\r\n\t\tplain\r\n');
  });

  // Not a bypass, and worth pinning so nobody "fixes" it: spreadsheets do NOT
  // strip a leading space before formula detection, so the space is itself the
  // neutralizer. Adding it would mangle legitimately space-padded labels.
  it('leaves a leading space alone, which is already safe', () => {
    expect(rows(cells([' =1+1']))[1]).toBe(' =1+1');
  });

  // The NUMERIC anchors are load-bearing. Relaxing them to /^\s*...\s*$/ —
  // which looks like harmless leniency — passed all 24 original tests while
  // re-opening exactly the whitespace-smuggling class above.
  // Asserted against the raw CSV, not the rows() helper: that helper trimEnd()s
  // and splits on \r\n, which eats a trailing space and mangles a quoted field
  // containing a newline — both of which are exactly what's under test here.
  it('does not treat a whitespace-padded number as numeric, which would defeat the trigger set', () => {
    expect(frameToCsv(cells(['\t-1.5']))).toContain("'\t-1.5");
    expect(frameToCsv(cells(['\t-1+1']))).toContain("'\t-1+1");
    expect(frameToCsv(cells(['\n-1.5']))).toContain("\"'\n-1.5\"");
  });

  it('neutralizes a trailing-whitespace number, which is not a value we need to preserve', () => {
    expect(frameToCsv(cells(['-1.5 ']))).toContain("'-1.5 ");
  });
});

describe('parseCsv (document-level RFC 4180)', () => {
  it('parses simple CRLF rows', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps a comma inside a quoted field', () => {
    expect(parseCsv('"a,b",c')).toEqual([['a,b', 'c']]);
  });

  it('keeps a newline inside a quoted field as one field on one row', () => {
    // The whole reason this can't be a line-oriented parser: the CRLF here is
    // data, not a record separator, so this is ONE row of two fields.
    expect(parseCsv('"line1\r\nline2",b\r\n')).toEqual([['line1\r\nline2', 'b']]);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsv('"he said ""hi""",x')).toEqual([['he said "hi"', 'x']]);
  });

  it('does not emit a spurious empty final row for a trailing separator', () => {
    expect(parseCsv('a\r\n')).toEqual([['a']]);
    expect(parseCsv('a,b\r\n')).toEqual([['a', 'b']]);
  });

  it('emits the final row when there is no trailing separator', () => {
    expect(parseCsv('a,b')).toEqual([['a', 'b']]);
  });

  it('accepts a lone \\n and a lone \\r as record separators', () => {
    expect(parseCsv('a\nb')).toEqual([['a'], ['b']]);
    expect(parseCsv('a\rb')).toEqual([['a'], ['b']]);
  });

  it('preserves empty fields', () => {
    expect(parseCsv('a,,b')).toEqual([['a', '', 'b']]);
  });

  it('represents a blank interior line as a single empty field', () => {
    expect(parseCsv('a\r\n\r\nb')).toEqual([['a'], [''], ['b']]);
  });

  it('returns no rows for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('neutralizeCsvDocument (Grafana-captured CSV path, issue #91)', () => {
  it('round-trips a plain document, minimizing quotes and normalizing to CRLF', () => {
    const { csv, rows } = neutralizeCsvDocument('"a","b"\nx,y\n');
    expect(csv).toBe('a,b\r\nx,y\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x', 'y'],
    ]);
  });

  it('neutralizes a formula-leading cell with a leading apostrophe', () => {
    const { csv, rows } = neutralizeCsvDocument('h\r\n=1+1\r\n');
    expect(csv).toBe("h\r\n'=1+1\r\n");
    // The returned rows are the raw parse (pre-neutralization) — the caller
    // neutralizes them itself for column reporting.
    expect(rows[1]).toEqual(['=1+1']);
  });

  it('neutralizes a formula lead that was hidden inside a quoted field', () => {
    // "=1,2" is quoted only because of its comma; the = is still a formula lead
    // once parsed, and must be neutralized (and then re-quoted for the comma).
    expect(neutralizeCsvDocument('h\r\n"=1,2"\r\n').csv).toBe('h\r\n"\'=1,2"\r\n');
  });

  it('re-quotes a field whose value contains a newline, counting it as one row', () => {
    const { csv, rows } = neutralizeCsvDocument('h\r\n"a\nb"\r\n');
    expect(csv).toBe('h\r\n"a\nb"\r\n');
    expect(rows).toHaveLength(2); // header + one data row, not three lines
  });

  it('leaves a legitimate negative number untouched', () => {
    expect(neutralizeCsvDocument('h\r\n-1.5\r\n').csv).toBe('h\r\n-1.5\r\n');
  });

  it('preserves a leading UTF-8 BOM', () => {
    const bom = String.fromCharCode(0xfeff);
    const { csv } = neutralizeCsvDocument(`${bom}a,b\r\n`);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe(`${bom}a,b\r\n`);
  });

  it('returns empty output for empty input', () => {
    expect(neutralizeCsvDocument('')).toEqual({ csv: '', rows: [] });
  });
});

describe('resolutionFromTimestamps', () => {
  it('reports the median gap, point count, and span as an exact resolution', () => {
    const min = 60_000;
    expect(resolutionFromTimestamps([0, 5 * min, 10 * min, 15 * min])).toEqual({
      points: 4,
      effectiveBucketMs: 5 * min,
      spanMs: 15 * min,
      approximate: false,
    });
  });

  it('uses the median so one irregular gap does not move the figure', () => {
    // Gaps: 5, 5, 60 (one hole) — median stays 5, not the 23.3 a mean would give.
    const min = 60_000;
    expect(resolutionFromTimestamps([0, 5 * min, 10 * min, 70 * min])?.effectiveBucketMs).toBe(5 * min);
  });

  it('dedupes and sorts before measuring', () => {
    expect(resolutionFromTimestamps([120_000, 0, 60_000, 60_000])).toMatchObject({ points: 3, effectiveBucketMs: 60_000 });
  });

  it('returns undefined below two distinct points', () => {
    expect(resolutionFromTimestamps([])).toBeUndefined();
    expect(resolutionFromTimestamps([1000])).toBeUndefined();
    expect(resolutionFromTimestamps([1000, 1000])).toBeUndefined();
  });
});

describe('approximateResolution', () => {
  it('derives the bucket from row count over the window and flags it approximate', () => {
    // 8065 rows over 28 days ≈ 5-minute buckets — the #111 target.
    const twentyEightDaysMs = 28 * 24 * 60 * 60 * 1000;
    const r = approximateResolution(8065, twentyEightDaysMs);
    expect(r?.approximate).toBe(true);
    expect(r?.points).toBe(8065);
    expect(Math.round((r?.effectiveBucketMs ?? 0) / 60_000)).toBe(5);
  });

  it('returns undefined when it cannot say anything useful', () => {
    expect(approximateResolution(1, 1000)).toBeUndefined();
    expect(approximateResolution(10, 0)).toBeUndefined();
  });
});
