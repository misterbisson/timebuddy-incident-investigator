export interface TimeWindow {
  label: string;
  fromMs: number;
  toMs: number;
}

export interface WindowSet {
  /** The alert's own start/end, exactly as reported. */
  incident: TimeWindow;
  /** A short buffer before the incident window, to see the anomaly's onset. */
  preWindow: TimeWindow;
  /** Same-duration windows shifted into the past, for baseline comparison. */
  controls: TimeWindow[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export interface ComputeWindowsParams {
  startsAtMs: number;
  /** Defaults to now, for still-firing alerts. */
  endsAtMs?: number;
  preWindowMs?: number;
  /** Named offsets (ms) shifting the incident window into the past for baselining. */
  controlOffsets?: Array<{ label: string; offsetMs: number }>;
  nowMs?: number;
}

const DEFAULT_CONTROL_OFFSETS: Array<{ label: string; offsetMs: number }> = [
  { label: 'prior-hour', offsetMs: HOUR_MS },
  { label: 'same-hour-yesterday', offsetMs: DAY_MS },
  { label: 'same-hour-last-week', offsetMs: WEEK_MS },
];

/**
 * Builds the incident window plus a pre-window buffer and control (baseline)
 * windows of matching duration shifted into the past. Callers needing a
 * "quiet period" comparison can pass a custom controlOffsets entry.
 */
export function computeWindows(params: ComputeWindowsParams): WindowSet {
  const now = params.nowMs ?? Date.now();
  const endsAtMs = params.endsAtMs ?? now;
  if (endsAtMs < params.startsAtMs) {
    throw new Error(`endsAtMs (${endsAtMs}) is before startsAtMs (${params.startsAtMs})`);
  }
  const duration = endsAtMs - params.startsAtMs;
  const preWindowMs = params.preWindowMs ?? Math.max(30 * 60_000, duration);

  const incident: TimeWindow = { label: 'incident', fromMs: params.startsAtMs, toMs: endsAtMs };
  const preWindow: TimeWindow = {
    label: 'pre-window',
    fromMs: params.startsAtMs - preWindowMs,
    toMs: params.startsAtMs,
  };
  const offsets = params.controlOffsets ?? DEFAULT_CONTROL_OFFSETS;
  const controls: TimeWindow[] = offsets.map(({ label, offsetMs }) => ({
    label,
    fromMs: params.startsAtMs - offsetMs,
    toMs: endsAtMs - offsetMs,
  }));

  return { incident, preWindow, controls };
}

export function windowDurationMs(w: TimeWindow): number {
  return w.toMs - w.fromMs;
}
