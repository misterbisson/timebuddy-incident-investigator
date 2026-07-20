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

export function buildDsQueryTarget(target: ResolvedTarget, maxDataPoints: number): DsQueryTarget {
  if (!target.datasourceUid) {
    throw new Error(`Target ${target.refId} has no resolvable datasource uid`);
  }
  const { refId: _refId, datasource: _datasource, ...rest } = target.raw;
  return {
    ...rest,
    refId: target.refId,
    datasource: { uid: target.datasourceUid },
    maxDataPoints,
  };
}

function parseFrames(response: DsQueryResponse): { series: QuerySeries[]; errors: Record<string, string> } {
  const series: QuerySeries[] = [];
  const errors: Record<string, string> = {};

  for (const [refId, result] of Object.entries(response.results)) {
    if (result.error) {
      errors[refId] = result.error;
      continue;
    }
    for (const frame of result.frames ?? []) {
      const timeFieldIdx = frame.schema.fields.findIndex((f) => f.type === 'time');
      if (timeFieldIdx === -1) continue;
      const timeValues = frame.data.values[timeFieldIdx] ?? [];

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
