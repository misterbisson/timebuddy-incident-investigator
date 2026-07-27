import { describe, expect, it } from 'vitest';
import { rankCorrelatedAnomalies, type CorrelationCandidateInput } from '../src/analysis/correlation.js';
import type { SeriesPoint } from '../src/query/executor.js';

function points(values: number[]): SeriesPoint[] {
  return values.map((v, i) => ({ t: i * 60_000, v }));
}

function candidate(overrides: Partial<CorrelationCandidateInput>): CorrelationCandidateInput {
  return {
    dashboardUid: 'd',
    dashboardTitle: 'D',
    panelId: 1,
    labels: {},
    incidentPoints: points([0, 0, 0]),
    preWindowPoints: points([0, 0, 0]),
    ...overrides,
  };
}

describe('rankCorrelatedAnomalies', () => {
  // Finding #147: baseline.ts deliberately reports 'baseline-all-zero' with
  // zScore: NaN for a presence-change signal (every control window flat zero,
  // incident window not) rather than a spurious ~1e8-sigma z-score. Before the
  // fix, rankCorrelatedAnomalies coerced that NaN straight to 0, scoring a
  // genuine presence-change candidate identically to one that never moved at
  // all — indistinguishable from noise and liable to be sorted to the bottom
  // (or filtered out by summarize_findings' score threshold) instead of
  // surfacing as the real signal it is.
  it('does not zero out a baseline-all-zero presence-change candidate', () => {
    const results = rankCorrelatedAnomalies(
      [candidate({ dashboardUid: 'presence-change', incidentPoints: points([0, 5, 5, 5]), preWindowPoints: points([0, 0, 0, 0]) })],
      {},
      undefined,
    );
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it('ranks a baseline-all-zero presence-change candidate above one whose baseline comparison found nothing at all', () => {
    const results = rankCorrelatedAnomalies(
      [
        candidate({ dashboardUid: 'flat', incidentPoints: points([0, 0, 0, 0]), preWindowPoints: points([0, 0, 0, 0]) }),
        candidate({ dashboardUid: 'presence-change', incidentPoints: points([0, 5, 5, 5]), preWindowPoints: points([0, 0, 0, 0]) }),
      ],
      {},
      undefined,
    );
    expect(results[0]?.dashboardUid).toBe('presence-change');
    expect(results[0]?.score).toBeGreaterThan(results[1]!.score);
  });

  it('still scores a genuine statistical deviation on its z-score, unaffected by the presence-change carve-out', () => {
    const results = rankCorrelatedAnomalies(
      [candidate({ incidentPoints: points([100, 102, 98, 105]), preWindowPoints: points([10, 11, 9, 10]) })],
      {},
      undefined,
    );
    expect(results[0]?.zScore).toBeGreaterThan(3);
    expect(results[0]?.score).toBeGreaterThan(3);
  });

  it('scores an all-zero incident against an all-zero baseline as unremarkable (no presence change actually occurred)', () => {
    const results = rankCorrelatedAnomalies(
      [candidate({ incidentPoints: points([0, 0, 0, 0]), preWindowPoints: points([0, 0, 0, 0]) })],
      {},
      undefined,
    );
    expect(results[0]?.score).toBe(0);
  });
});
