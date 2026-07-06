import type { BaselineComparison } from './baseline.js';
import type { CorrelationResult } from './correlation.js';

export type Verdict = 'real-anomaly' | 'likely-false-positive' | 'inconclusive';

export interface EvidenceLink {
  description: string;
  dashboardUid?: string;
  panelId?: number;
  url?: string;
}

export interface SummarizeFindingsInput {
  alertName?: string;
  labels: Record<string, string>;
  baseline: BaselineComparison;
  /** Whether the incident window's value crossed the alert's own threshold; undefined if unknown. */
  thresholdCrossed?: boolean;
  correlated: CorrelationResult[];
  /** Minimum score for a correlated candidate to count as "confirmed related", not just "checked". */
  correlationScoreThreshold?: number;
  evidence: EvidenceLink[];
  warnings: string[];
}

export interface FindingsReport {
  verdict: Verdict;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  triggeredSignal: {
    alertName?: string;
    labels: Record<string, string>;
    zScore: number;
    classification: BaselineComparison['classification'];
  };
  correlatedSignals: CorrelationResult[];
  likelyScope: string;
  evidence: EvidenceLink[];
  missingData: string[];
}

/**
 * Deterministic verdict assembly — no free-text generation here. This turns
 * the other tools' structured outputs into a verdict + evidence bundle; the
 * calling agent is responsible for writing the human-readable incident note
 * from this bundle, so every claim in that note traces back to a concrete
 * dashboard/panel/query result rather than to a paraphrase of one.
 */
export function summarizeFindings(input: SummarizeFindingsInput): FindingsReport {
  const reasons: string[] = [];
  const missingData = [...input.warnings];
  const scoreThreshold = input.correlationScoreThreshold ?? 1;
  const confirmedCorrelated = input.correlated.filter((c) => c.score >= scoreThreshold);

  if (input.baseline.classification === 'insufficient-data') {
    missingData.push('Not enough baseline data (prior hour/day/week) was available to compare against.');
    return {
      verdict: 'inconclusive',
      confidence: 'low',
      reasons: ['Insufficient baseline data to classify this signal.'],
      triggeredSignal: {
        alertName: input.alertName,
        labels: input.labels,
        zScore: input.baseline.zScore,
        classification: input.baseline.classification,
      },
      correlatedSignals: confirmedCorrelated,
      likelyScope: 'unknown',
      evidence: input.evidence,
      missingData,
    };
  }

  const unusual = input.baseline.classification === 'statistically-unusual';
  const zAbs = Math.abs(input.baseline.zScore);

  if (unusual && input.thresholdCrossed !== false) {
    reasons.push(
      `Incident window deviates ${zAbs.toFixed(1)}σ from the pooled baseline (prior hour/day/week), which is statistically unusual.`,
    );
    if (confirmedCorrelated.length > 0) {
      reasons.push(
        `${confirmedCorrelated.length} correlated signal(s) moved in the same window: ${confirmedCorrelated
          .slice(0, 5)
          .map((c) => c.panelTitle ?? `panel ${c.panelId}`)
          .join(', ')}.`,
      );
    }
    return {
      verdict: 'real-anomaly',
      confidence: input.thresholdCrossed === true ? 'high' : 'medium',
      reasons,
      triggeredSignal: {
        alertName: input.alertName,
        labels: input.labels,
        zScore: input.baseline.zScore,
        classification: input.baseline.classification,
      },
      correlatedSignals: confirmedCorrelated,
      likelyScope: describeScope(confirmedCorrelated),
      evidence: input.evidence,
      missingData,
    };
  }

  if (!unusual) {
    reasons.push('Incident window falls within normal baseline variation (prior hour/day/week) for this signal.');
    return {
      verdict: 'likely-false-positive',
      confidence: 'medium',
      reasons,
      triggeredSignal: {
        alertName: input.alertName,
        labels: input.labels,
        zScore: input.baseline.zScore,
        classification: input.baseline.classification,
      },
      correlatedSignals: confirmedCorrelated,
      likelyScope: 'none',
      evidence: input.evidence,
      missingData,
    };
  }

  reasons.push('Signal is statistically unusual but did not clearly cross the alert threshold — mixed evidence.');
  return {
    verdict: 'inconclusive',
    confidence: 'low',
    reasons,
    triggeredSignal: {
      alertName: input.alertName,
      labels: input.labels,
      zScore: input.baseline.zScore,
      classification: input.baseline.classification,
    },
    correlatedSignals: confirmedCorrelated,
    likelyScope: describeScope(confirmedCorrelated),
    evidence: input.evidence,
    missingData,
  };
}

function describeScope(correlated: CorrelationResult[]): string {
  if (correlated.length === 0) return 'isolated to the alerting signal';
  const dashboards = new Set(correlated.map((c) => c.dashboardTitle));
  return `spans ${dashboards.size} dashboard(s): ${[...dashboards].slice(0, 5).join(', ')}`;
}
