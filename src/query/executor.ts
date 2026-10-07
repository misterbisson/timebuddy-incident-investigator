import type { Config } from '../config.js';
import type { GrafanaClient } from '../grafana/client.js';
import type { DsQueryRequest, DsQueryResponse, DsQueryTarget } from '../grafana/types.js';
import type { ResolvedTarget } from '../dashboards/panelQueries.js';
import { clampMaxDataPoints, enforceWindowLimit } from '../security/limits.js';
import type { TimeWindow } from './windows.js';

export interface SeriesPoint {
  t: number;
  v: number | null;
}

export interface QuerySeries {
  refId: string;
  labels: Record<string, string>;
  points: SeriesPoint[];
  /** Untruncated point count. Larger than points.length when the datasource ignored maxDataPoints and this series was downsampled. */
  pointsTotal: number;
}

export interface WindowQueryResult {
  window: TimeWindow;
  series: QuerySeries[];
  /** refId -> error message, for queries the datasource rejected. */
  errors: Record<string, string>;
}

/**
 * `intervalMs` goes out only when the target carries one (a panel that declares
 * a min interval — see dashboards/panelStep.ts). Grafana's backends take a sent
 * `intervalMs` as the step floor *in place of* the datasource's own default, so
 * sending a computed one for a panel that declares nothing would drop the
 * datasource's scrape-interval floor rather than reproduce the panel.
 */
export function buildDsQueryTarget(target: ResolvedTarget, maxDataPoints: number): DsQueryTarget {
  if (!target.datasourceUid) {
    throw new Error(`Target ${target.refId} has no resolvable datasource uid`);
  }
  const { refId: _refId, datasource: _datasource, ...rest } = target.raw;
  return {
    ...rest,
    refId: target.refId,
    datasource: { uid: target.datasourceUid },
    maxDataPoints: target.maxDataPoints ?? maxDataPoints,
    ...(target.intervalMs !== undefined ? { intervalMs: target.intervalMs } : {}),
  };
}

/**
 * The message for a refId whose frames all came back as text rows (#263): a
 * time field, at least one string field, and no numeric field — a log query's
 * result, or a query selecting only string-valued fields. Nothing downstream here can analyze
 * that, and dropping it silently made "this query returned log lines" read as
 * "this panel had no data in the window", which is the worse of the two
 * failures. Reported even at zero rows: an empty log result is still a log
 * query, and saying "no data" would still be the wrong answer to it.
 */
function textRowsMessage(rows: number): string {
  return (
    `Query returned ${rows} row(s) of text (log lines, or a string-valued field) rather than numeric series, so ` +
    'there is nothing here to compute stats or baselines over. For a log query, count lines instead by wrapping ' +
    'it in a metric query — e.g. sum(count_over_time(<query> [1m])) — and replay that.'
  );
}

function parseFrames(response: DsQueryResponse): { series: QuerySeries[]; errors: Record<string, string> } {
  const series: QuerySeries[] = [];
  const errors: Record<string, string> = {};
  // Text-row counts per refId, turned into errors only after every frame is
  // read. The check is per frame but errors are per refId, and one refId can
  // return both kinds: InfluxQL emits one frame per selected column, so
  // SELECT mean("value"), last("state") is a numeric frame plus a string one.
  // That refId has real series, and "nothing here to compute" would be false
  // for it, so its text frame is dropped as it always was. Only a refId whose
  // frames were *all* text — the #263 case — is reported.
  const textRows = new Map<string, number>();

  for (const [refId, result] of Object.entries(response.results)) {
    if (result.error) {
      errors[refId] = result.error;
      continue;
    }
    for (const frame of result.frames ?? []) {
      const timeFieldIdx = frame.schema.fields.findIndex((f) => f.type === 'time');
      if (timeFieldIdx === -1) continue;
      const timeValues = frame.data.values[timeFieldIdx] ?? [];
      const fieldTypes = frame.schema.fields.map((f) => f.type);
      if (!fieldTypes.includes('number') && fieldTypes.includes('string')) {
        const frameRefId = frame.schema.refId ?? refId;
        textRows.set(frameRefId, (textRows.get(frameRefId) ?? 0) + timeValues.length);
        continue;
      }

      frame.schema.fields.forEach((field, idx) => {
        if (idx === timeFieldIdx || field.type !== 'number') return;
        const values = frame.data.values[idx] ?? [];
        const points: SeriesPoint[] = timeValues.map((t, i) => ({
          t: t as number,
          v: (values[i] as number | null) ?? null,
        }));
        series.push({ refId: frame.schema.refId ?? refId, labels: field.labels ?? {}, points, pointsTotal: points.length });
      });
    }
  }
  const numericRefIds = new Set(series.map((s) => s.refId));
  for (const [refId, rows] of textRows) {
    if (!numericRefIds.has(refId)) errors[refId] ??= textRowsMessage(rows);
  }
  return { series, errors };
}

/** Executes a set of already variable-substituted targets over one time window. */
export async function executeQueryWindow(
  client: GrafanaClient,
  targets: ResolvedTarget[],
  window: TimeWindow,
  config: Config,
): Promise<WindowQueryResult> {
  enforceWindowLimit(window, config);
  const maxDataPoints = clampMaxDataPoints(undefined, config);

  const request: DsQueryRequest = {
    from: String(window.fromMs),
    to: String(window.toMs),
    queries: targets.map((t) => buildDsQueryTarget(t, maxDataPoints)),
  };
  const response = await client.queryDs(request);
  const { series, errors } = parseFrames(response);
  // Full, un-downsampled series on purpose. clampSeriesPoints is a *response*
  // shaping step and belongs at the point where points are emitted to the
  // model (execute_query_window and render_dashboard both apply it), not here:
  // clamping at this boundary also truncated the input to every analysis
  // downstream, so computeStats/findThresholdRuns/compareToBaseline all ran on
  // a subsample. A raw InfluxQL target with no `GROUP BY time()` returns ~21.6k
  // points over 6h against a 2000 default, and a short outage lands entirely
  // between surviving samples — the tool then reports "never left full health"
  // during a real one. Callers that analyze but don't emit points
  // (validate_baseline, detect_correlated_anomalies) need the full series and
  // return no raw points, so nothing here reaches the model unclamped.
  return { window, series, errors };
}

/** Executes the same targets across several windows (incident + baselines) in parallel. */
export async function executeQueryWindows(
  client: GrafanaClient,
  targets: ResolvedTarget[],
  windows: TimeWindow[],
  config: Config,
): Promise<WindowQueryResult[]> {
  return Promise.all(windows.map((w) => executeQueryWindow(client, targets, w, config)));
}
