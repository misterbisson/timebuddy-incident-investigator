import type { Config } from '../config.js';
import type { TimeWindow } from '../query/windows.js';

export class LimitExceededError extends Error {}

/** Rejects windows wider than the configured max lookback (protects against runaway queries). */
export function enforceWindowLimit(window: TimeWindow, config: Config): void {
  const spanHours = (window.toMs - window.fromMs) / 3_600_000;
  if (spanHours > config.maxLookbackHours) {
    throw new LimitExceededError(
      `Requested window "${window.label}" spans ${spanHours.toFixed(1)}h, exceeding MAX_LOOKBACK_HOURS=${config.maxLookbackHours}`,
    );
  }
  if (window.toMs <= window.fromMs) {
    throw new LimitExceededError(`Window "${window.label}" has a non-positive duration`);
  }
}

/** Caps maxDataPoints so a single query can't request an unbounded number of samples. */
export function clampMaxDataPoints(requested: number | undefined, config: Config): number {
  if (!requested) return config.maxDataPoints;
  return Math.min(requested, config.maxDataPoints);
}
