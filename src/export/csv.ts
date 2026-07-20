import type { GrafanaFrame } from '../grafana/types.js';
import type { QuerySeries } from '../query/executor.js';

/**
 * A cell that a spreadsheet would evaluate rather than display. Excel,
 * LibreOffice, and Google Sheets all treat a leading =, +, -, or @ as the
 * start of a formula. The whitespace characters are here for a second reason:
 * they're stripped *before* that check, so they smuggle the character after
 * them into the leading position. The whole ASCII whitespace class is included
 * rather than just tab and CR — LF is equally reachable (frameToCsv passes
 * arbitrary string fields through verbatim) and costs nothing to cover.
 *
 * A leading *space* is deliberately not in this set, and that's not an
 * oversight: spreadsheets don't strip it before formula detection, so the
 * space is itself the neutralizer. Same for NBSP.
 *
 * This matters here specifically because export_panel_csv writes to DATA_DIR
 * for a person to open in a spreadsheet — that's the tool's whole purpose, so
 * "the file is only ever read by a program" isn't available as a mitigation.
 * The contents aren't trusted input either: column names derive from
 * Grafana-supplied refId/label values, and frameToCsv passes through arbitrary
 * string fields from query results.
 */
const FORMULA_LEAD = /^[=+\-@\t\r\n\v\f]/;

/**
 * Numbers must survive this untouched. `-1.5` is both a legitimate value and a
 * formula lead, and it arrives here as a string via formatCell's String(...) —
 * neutralizing it would turn every negative number in the file into text and
 * break the numeric analysis the export exists to enable. Anchored and
 * deliberately strict: "-Infinity"/"-NaN" don't match, so they get neutralized
 * rather than passed through, which is harmless since neither is analyzable as
 * a number anyway.
 *
 * The anchors are load-bearing, not stylistic. Allowing surrounding whitespace
 * (`^\s*...\s*$`) would widen this exemption to cover exactly the
 * tab/CR/LF-prefixed smuggling that FORMULA_LEAD exists to catch — `"\t-1+1"`
 * would match as "numeric" and ship unneutralized. Pinned by tests for that
 * reason.
 */
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Prefixes a formula-leading cell with an apostrophe, the standard
 * neutralization: spreadsheets consume it as "treat the rest as literal text"
 * and don't display it. Quoting alone is not sufficient — Excel evaluates a
 * quoted field's contents just the same, so RFC 4180 escaping is not a defense
 * against this and never was.
 */
export function neutralizeFormula(value: string): string {
  if (!FORMULA_LEAD.test(value) || NUMERIC.test(value)) return value;
  return `'${value}`;
}

function escapeCsvField(value: string): string {
  // Neutralize first, then quote: the apostrophe has to land inside the quotes
  // to be the cell's first character, which is the position that matters.
  const safe = neutralizeFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsvRow(fields: string[]): string {
  return fields.map(escapeCsvField).join(',');
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** One series' column header: its labels as sorted key=value pairs, or its refId when it has none (e.g. a query with no legend-defining labels). */
function seriesColumnName(series: Pick<QuerySeries, 'refId' | 'labels'>): string {
  const entries = Object.entries(series.labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.length > 0 ? entries.map(([k, v]) => `${k}=${v}`).join(',') : series.refId;
}

/**
 * Column names for a set of series, in order, with collisions (e.g. two
 * series sharing a refId and no labels) disambiguated by suffix — exported
 * separately from seriesToCsv so a caller can report "here's what's in the
 * file" without re-deriving the same dedupe logic.
 */
export function buildSeriesColumnNames(series: Array<Pick<QuerySeries, 'refId' | 'labels'>>): string[] {
  const counts = new Map<string, number>();
  return series.map((s) => {
    const name = seriesColumnName(s);
    const seen = counts.get(name) ?? 0;
    counts.set(name, seen + 1);
    return seen === 0 ? name : `${name} (${seen + 1})`;
  });
}

/**
 * Wide-format CSV for a set of timeseries: one UTC-timestamp column plus one
 * column per series. Series are outer-joined on timestamp rather than
 * assumed to share sample times — different targets/datasources can scrape
 * or bucket at different rates, and inner-joining would silently drop points
 * from whichever series doesn't happen to align.
 */
export function seriesToCsv(series: QuerySeries[]): string {
  const names = buildSeriesColumnNames(series);
  const timestamps = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
  const valuesByTime = series.map((s) => new Map(s.points.map((p) => [p.t, p.v])));

  const lines = [toCsvRow(['timestamp', ...names])];
  for (const t of timestamps) {
    const row = [new Date(t).toISOString(), ...valuesByTime.map((m) => formatCell(m.get(t)))];
    lines.push(toCsvRow(row));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Parses one CSV row (RFC 4180: comma-separated, double-quote-quoted fields
 * with "" escaping) — used only to report column/row metadata about a CSV
 * this server didn't itself generate (Grafana's own "Download CSV" output,
 * captured via a real browser — see tools/exportPanelCsv.ts), not for
 * anything data-critical.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      fields.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * "As-is" CSV for one raw Grafana data frame (a table panel's query result):
 * every field becomes a column, in schema order — including string/boolean
 * fields, unlike query/executor.ts's parseFrames which only extracts number
 * fields paired with a time field, since that's timeseries-shaped and would
 * silently drop a table's dimension columns.
 */
export function frameToCsv(frame: GrafanaFrame): string {
  const fields = frame.schema.fields;
  const rowCount = Math.max(0, ...frame.data.values.map((col) => col.length));
  const lines = [toCsvRow(fields.map((f) => f.name))];
  for (let i = 0; i < rowCount; i++) {
    const row = fields.map((field, idx) => {
      const raw = frame.data.values[idx]?.[i];
      if (raw === null || raw === undefined) return '';
      if (field.type === 'time' && typeof raw === 'number') return new Date(raw).toISOString();
      return formatCell(raw);
    });
    lines.push(toCsvRow(row));
  }
  return lines.join('\r\n') + '\r\n';
}
