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

  // A metric that was flat zero across every control window and is nonzero now
  // is real information, but it is not a sigma deviation and must never be
  // scored as one — there is no baseline spread to be confident against. So
  // this branch reports magnitude rather than z-score, and caps confidence at
  // medium however strong the corroboration: "this never happened before and
  // is happening now" is a genuine finding, and also the entire finding.
  if (input.baseline.classification === 'baseline-all-zero') {
    const { max, nonZeroCount, count } = input.baseline.incidentStats;
    reasons.push(
      `Every control window (prior hour/day/week) was flat zero; the incident window has ${nonZeroCount} nonzero ` +
        `sample(s) of ${count}, peaking at ${max}. That's a presence change rather than a deviation — no baseline ` +
        'spread exists to compute a meaningful z-score against, so judge this on magnitude and corroboration.',
    );
    if (confirmedCorrelated.length > 0) {
      reasons.push(
        `${confirmedCorrelated.length} correlated signal(s) moved in the same window: ${confirmedCorrelated
          .slice(0, 5)
          .map((c) => c.panelTitle ?? `panel ${c.panelId}`)
          .join(', ')}.`,
      );
    }
    if (input.thresholdCrossed !== true) {
      missingData.push(
        'Baseline was all zeros, so the usual statistical comparison does not apply — confirm whether this ' +
          "magnitude is operationally significant for this metric, which the baseline can't tell you.",
      );
    }
    const corroborated = input.thresholdCrossed === true || confirmedCorrelated.length > 0;
    return {
      verdict: input.thresholdCrossed === true ? 'real-anomaly' : 'inconclusive',
      confidence: corroborated ? 'medium' : 'low',
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

  const unusual = input.baseline.classification === 'statistically-unusual';
  const zAbs = Math.abs(input.baseline.zScore);
  const briefExcursions = input.baseline.briefExcursions ?? [];

  if (unusual && input.thresholdCrossed !== false) {
    reasons.push(
      `Incident window deviates ${zAbs.toFixed(1)}σ from the pooled baseline (prior hour/day/week), which is statistically unusual.`,
    );
    if (briefExcursions.length > 0) {
      reasons.push(
        `${briefExcursions.length} brief excursion(s) beyond the baseline's 2σ band corroborate this independently of the whole-window mean.`,
      );
    }
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
    // A whole-window mean can dilute a short, real event inside a long analysis window down
    // below zThreshold (averaging is the wrong operation for "did something briefly go to
    // zero") — briefExcursions catches this independently, at a fixed, more sensitive 2σ bar.
    // Never call this a false positive while ignoring evidence that contradicts it; report
    // inconclusive instead and point at exactly what needs a human/agent look before deciding.
    if (briefExcursions.length > 0) {
      reasons.push(
        'Incident window\'s whole-window mean falls within normal baseline variation, but ' +
          `${briefExcursions.length} brief excursion(s) crossed the baseline's stricter 2σ band — a short, real ` +
          'event inside a long window can be diluted below the whole-window threshold. Check these excursions\' ' +
          'times/magnitudes (and any correlated volume) before treating this as a false positive.',
      );
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
