import type { GrafanaFrame } from '../grafana/types.js';
import type { QuerySeries } from '../query/executor.js';

function escapeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
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
