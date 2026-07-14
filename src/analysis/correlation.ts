import { compareToBaseline, computeStats, detectOnset } from './baseline.js';
import type { SeriesPoint } from '../query/executor.js';

export interface CorrelationCandidateInput {
  dashboardUid: string;
  dashboardTitle: string;
  panelId: number;
  panelTitle?: string;
  labels: Record<string, string>;
  incidentPoints: SeriesPoint[];
  preWindowPoints: SeriesPoint[];
  /** Which Grafana connection this candidate was fetched from, when there's more than one. */
  connectionId?: string;
}

export interface CorrelationResult {
  dashboardUid: string;
  dashboardTitle: string;
  panelId: number;
  panelTitle?: string;
  labels: Record<string, string>;
  zScore: number;
  labelOverlapCount: number;
  onsetLagMs?: number;
  score: number;
  connectionId?: string;
}

function labelOverlapCount(primary: Record<string, string>, candidate: Record<string, string>): number {
  let count = 0;
  for (const [key, value] of Object.entries(primary)) {
    if (candidate[key] === value) count++;
  }
  return count;
}

/**
 * Ranks candidate panels by how likely they are to be part of the same
 * incident: deviation strength (z-score vs. that panel's own pre-window
 * baseline), label overlap with the primary alert (service/host/region/...),
 * and how closely their anomaly onset lines up with the primary's. This is
 * a heuristic, not a statistical correlation test — it's meant to triage
 * "what else moved" for a human/agent to look at, not to prove causation.
 */
export function rankCorrelatedAnomalies(
  candidates: CorrelationCandidateInput[],
  primaryLabels: Record<string, string>,
  primaryOnsetMs: number | undefined,
  zThreshold = 3,
): CorrelationResult[] {
  const results = candidates.map((c) => {
    const comparison = compareToBaseline(c.incidentPoints, [{ label: 'pre-window', points: c.preWindowPoints }], zThreshold);
    const preWindowStats = computeStats(c.preWindowPoints);
    const onsetMs = detectOnset(c.incidentPoints, preWindowStats);
    const overlap = labelOverlapCount(primaryLabels, c.labels);

    let timingScore = 0;
    if (primaryOnsetMs !== undefined && onsetMs !== undefined) {
      const lagMinutes = Math.abs(onsetMs - primaryOnsetMs) / 60_000;
      timingScore = 1 / (1 + lagMinutes);
    }

    const zScore = Number.isFinite(comparison.zScore) ? comparison.zScore : 0;
    const score = Math.abs(zScore) * (1 + overlap) * (1 + timingScore);

    return {
      dashboardUid: c.dashboardUid,
      dashboardTitle: c.dashboardTitle,
      panelId: c.panelId,
      panelTitle: c.panelTitle,
      labels: c.labels,
      zScore,
      labelOverlapCount: overlap,
      onsetLagMs: primaryOnsetMs !== undefined && onsetMs !== undefined ? onsetMs - primaryOnsetMs : undefined,
      score,
      connectionId: c.connectionId,
    };
  });

  return results.sort((a, b) => b.score - a.score);
}
