import type { TemplateVariable } from '../grafana/types.js';
import type { ResolvedPanel, ResolvedTarget } from './panelQueries.js';
import { rangeIntervalMs, substituteVariables, type QueryWindow } from './variables.js';
import type { QuerySeries } from '../query/executor.js';
import { observedSpacing, reportedStep } from '../query/stepReport.js';

/**
 * The step a panel replay asks Grafana for, and where it came from.
 *
 * Issue #200: a panel's "Min interval" (`panel.interval`) is a floor on the step
 * Grafana evaluates its queries at, and for any range-vector function
 * (`increase`/`rate`/`delta`/`*_over_time`) the step decides the answer. The
 * replay used to drop it — the request carried no `intervalMs`, so Grafana's
 * backend fell back to the datasource default (15s for Prometheus) — and a panel
 * pinned at 1m reading a constant counter as 0 replayed as ~0.75/min of errors
 * that didn't exist. Nothing in the result said the step had changed.
 *
 * So this mirrors what Grafana's own panel query runner does: the floor is the
 * panel's min interval (or a caller's explicit `minIntervalMs`, which stands in
 * for it the way editing the panel's query options would), and the step is
 * `max(floor, span / maxDataPoints)` — the second term is why a long window can
 * still come back coarser than the panel declares, as it does in Grafana.
 *
 * A panel that declares no floor gets **no** `intervalMs`, deliberately. Grafana
 * treats a sent `intervalMs` as the floor *instead of* the datasource's own
 * (its configured scrape interval, or 15s for Prometheus when unset), so sending
 * a span-derived one would drop that floor and run finer than the panel renders
 * — the same bug in the other direction.
 */
export interface PanelStep {
  /** maxDataPoints sent with every target: the panel's own, capped at MAX_DATA_POINTS. */
  maxDataPoints: number;
  /** Sent as `intervalMs` and substituted for `$__interval`. Unset when no floor was declared. */
  intervalMs?: number;
  /** Which floor intervalMs came from; `datasource-default` when none was sent. */
  source: 'minIntervalMs' | 'panel' | 'datasource-default';
  /** The panel's declared min interval, verbatim. */
  panelInterval?: string;
  /** The panel's min interval after variable substitution, when it couldn't be read as a duration and was skipped. */
  panelIntervalIgnored?: string;
  /** The floor in ms, when one was in hand — lower than intervalMs when the window's point budget won. */
  floorMs?: number;
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  M: 2_592_000_000,
  y: 31_536_000_000,
};

/**
 * Reads a Grafana interval string as milliseconds: `1m`, `30s`, `500ms`, a bare
 * number of seconds, or any of those behind Grafana's legacy `>` ("at least")
 * prefix. Units and their sizes are Grafana's own (rangeutil's), `M` and `y`
 * included. Anything else is undefined rather than a guess — a step nobody
 * declared is the failure this module exists to stop.
 */
export function parseGrafanaIntervalMs(text: string): number | undefined {
  const trimmed = text.trim().replace(/^>/, '').trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|M|y)?$/.exec(trimmed);
  if (!match) return undefined;
  const ms = Number(match[1]) * UNIT_MS[match[2] ?? 's']!;
  return Number.isFinite(ms) && ms >= 1 ? Math.round(ms) : undefined;
}

/**
 * Resolves the step a replay of `panel` over `window` should request. A floor
 * that can't be parsed (an unknown unit, a variable with no usable value) is
 * skipped and reported as `panelIntervalIgnored`, the same way an unresolvable
 * time zone is skipped by the date-math layer: refusing would take out every
 * replay of a panel over one odd field.
 */
export function resolvePanelStep(args: {
  panel: Pick<ResolvedPanel, 'interval' | 'maxDataPoints'>;
  window: QueryWindow;
  variables: TemplateVariable[];
  overrides: Record<string, string[]>;
  configMaxDataPoints: number;
  minIntervalMs?: number;
}): PanelStep {
  const { panel, window, variables, overrides, configMaxDataPoints, minIntervalMs } = args;
  const maxDataPoints = Math.min(panel.maxDataPoints ?? configMaxDataPoints, configMaxDataPoints);
  const declared = panel.interval !== undefined ? { panelInterval: panel.interval } : {};

  let floorMs: number | undefined;
  let source: PanelStep['source'] = 'datasource-default';
  let panelIntervalIgnored: string | undefined;
  if (minIntervalMs !== undefined) {
    floorMs = minIntervalMs;
    source = 'minIntervalMs';
  } else if (panel.interval !== undefined) {
    const substituted = substituteVariables(panel.interval, variables, overrides, window, maxDataPoints);
    floorMs = parseGrafanaIntervalMs(substituted);
    if (floorMs === undefined) panelIntervalIgnored = substituted;
    else source = 'panel';
  }

  if (floorMs === undefined) {
    return { maxDataPoints, source, ...declared, ...(panelIntervalIgnored !== undefined ? { panelIntervalIgnored } : {}) };
  }
  const intervalMs = Math.max(floorMs, rangeIntervalMs(window.toMs - window.fromMs, maxDataPoints));
  return { maxDataPoints, intervalMs, source, floorMs, ...declared };
}

/** The window to substitute `$__interval` against, so the query text and the request's step agree. */
export function stepWindow<W extends QueryWindow>(window: W, step: PanelStep): W {
  return step.intervalMs !== undefined ? { ...window, intervalMs: step.intervalMs } : window;
}

/** Stamps a resolved step onto targets so buildDsQueryTarget sends it. */
export function withStep<T extends ResolvedTarget>(target: T, step: PanelStep): T {
  return {
    ...target,
    maxDataPoints: step.maxDataPoints,
    ...(step.intervalMs !== undefined ? { intervalMs: step.intervalMs } : {}),
  };
}

function formatMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/**
 * The `step` a replay result carries: what was requested and why, next to what
 * the returned timestamps say was used. #200's point is that this has to be on
 * the result itself — a step the caller has to back out of `pointsTotal` and
 * the window length is a step nobody checks mid-investigation.
 *
 * `note` is the timestamps' verdict (query/stepReport.ts, shared with
 * execute_adhoc_query); `sourceNote` says where the requested step came from
 * whenever that isn't simply "the panel's own min interval".
 */
export function describeReplayStep(step: PanelStep, series: QuerySeries[]): ReplayStepReport {
  const declared = {
    source: step.source,
    ...(step.panelInterval !== undefined ? { panelInterval: step.panelInterval } : {}),
    ...(step.panelIntervalIgnored !== undefined ? { panelIntervalIgnored: step.panelIntervalIgnored } : {}),
    maxDataPoints: step.maxDataPoints,
  };
  const sourceNote = replaySourceNote(step);
  const withSourceNote = sourceNote ? { sourceNote } : {};

  if (step.intervalMs === undefined) {
    const spacing = observedSpacing(series);
    return { ...declared, ...(spacing ?? {}), ...withSourceNote };
  }
  const { step: observed } = reportedStep(series, step.intervalMs);
  return { ...declared, ...observed, ...withSourceNote } as ReplayStepReport;
}

export interface ReplayStepReport {
  source: PanelStep['source'];
  panelInterval?: string;
  panelIntervalIgnored?: string;
  maxDataPoints: number;
  requestedMs?: number;
  observedGapGcdMs?: number;
  observedMinGapMs?: number;
  seriesMeasured?: number;
  consistentWithRequested?: boolean;
  note?: string;
  sourceNote?: string;
}

function replaySourceNote(step: PanelStep): string | undefined {
  if (step.intervalMs === undefined) {
    const why =
      step.panelIntervalIgnored !== undefined
        ? `The panel's min interval "${step.panelIntervalIgnored}" couldn't be read as a duration, so it was skipped`
        : 'The panel declares no min interval';
    return (
      `${why} and no step was requested: Grafana's datasource default chose it — the datasource's configured ` +
      'scrape interval (15s for Prometheus when unset), or span/maxDataPoints when that is larger. Range-vector ' +
      'functions (rate/increase/delta/*_over_time) answered at that step; observedGapGcdMs is a multiple of it. ' +
      'Pass minIntervalMs to choose one.'
    );
  }
  const parts: string[] = [];
  if (step.source === 'minIntervalMs') {
    parts.push(
      `Step floor set by minIntervalMs (${formatMs(step.floorMs!)})` +
        (step.panelInterval !== undefined ? `, replacing the panel's own "${step.panelInterval}"` : ', the panel declares none') +
        ' — these numbers answer at a step the panel does not render at.',
    );
  }
  if (step.floorMs !== undefined && step.intervalMs > step.floorMs) {
    parts.push(
      `The ${formatMs(step.floorMs)} floor is finer than this window allows at maxDataPoints=${step.maxDataPoints}, ` +
        `so the step is ${formatMs(step.intervalMs)} — Grafana coarsens a long range the same way.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}
