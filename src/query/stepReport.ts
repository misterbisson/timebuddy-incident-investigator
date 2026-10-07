import type { QuerySeries } from './executor.js';

/**
 * What a response's timestamps say about the step the datasource evaluated at.
 * Shared by execute_adhoc_query (a step the caller chose) and the panel replays
 * (a step the panel declared, or none) so both read the same evidence the same
 * way — see reportedStep for why that evidence is a divisor, not a step.
 */

/** Greatest common divisor, for reducing observed gaps to the coarsest step that could have produced them all. */
function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

/**
 * Reports what the returned timestamps say about the step the datasource used,
 * next to the step that was requested.
 *
 * This is issue #200's "report the step" ask: a requested step is a request, and Grafana's
 * Prometheus backend can still enlarge it (its own safe-resolution clamp), or an
 * older instance can read a field this client didn't send. A caller measuring
 * scrape density with `count_over_time(x[1m])` is asking a question *about* the
 * step, so an unverified echo of their own input would be the wrong answer to
 * give confidently.
 *
 * ## Why this reports a divisor and not "the observed step"
 *
 * The obvious implementation — median gap between timestamps, called the
 * effective step — is confidently wrong on sparse data, and wrong in the
 * direction that matters. Prometheus evaluates a range query on a fixed grid but
 * only *returns* a point where the range vector had samples, so a metric that
 * emits a handful of events an hour comes back as isolated points 15 minutes
 * apart even though the step was honoured exactly. A median-gap report would
 * call that a 900000ms step, flag a mismatch, and — because
 * `skills/investigate/SKILL.md` tells the agent to reread every number against
 * the reported step — turn a correct scrape-density measurement into an apparent
 * 15x error, on the exact query this tool is the right first move for.
 *
 * What the timestamps actually license is one inference, in one direction: every
 * gap is an integer multiple of the step that produced it, so **the step divides
 * the GCD of the gaps**. If the requested step does not divide that GCD, the
 * datasource cannot have used it — that is proof of an override (the #200 case:
 * gaps of 15000ms against a requested 60000ms). If it does divide it, the data
 * is *consistent with* the request and any wider spacing is sparsity. That is
 * strictly weaker than "the step was honoured" — a datasource that coarsened
 * 60000ms to 120000ms is indistinguishable from a metric that is simply sparse
 * at 60000ms — so the field is named for consistency rather than for a match it
 * can't establish.
 *
 * Measured across **every** series, not the first one that happens to have two
 * points: a response's first series can be a single-point outlier while the rest
 * are dense, and the datasource's step is a floor on the spacing any of them can
 * show, so more series can only sharpen the divisor.
 *
 * Deliberately measured on the pre-clamp series: clampSeriesPoints downsamples
 * with a uniform stride for the response, so measuring after it would report the
 * stride rather than anything about the datasource.
 */
export function reportedStep(series: QuerySeries[], requestedStepMs: number): { step: Record<string, unknown> } {
  const { gapGcdMs, minGapMs, seriesMeasured } = measureGaps(series);

  if (gapGcdMs === 0) {
    return {
      step: {
        requestedMs: requestedStepMs,
        note:
          'No series came back with two or more distinct timestamps, so nothing here can be said about the step ' +
          'the datasource used — most likely the query matched no data in this window.',
      },
    };
  }

  const consistentWithRequested = gapGcdMs % requestedStepMs === 0;
  const exact = consistentWithRequested && minGapMs === requestedStepMs;
  return {
    step: {
      requestedMs: requestedStepMs,
      /** GCD of every gap between consecutive returned timestamps: the step must divide this. */
      observedGapGcdMs: gapGcdMs,
      /** Tightest spacing any series came back with — an upper bound on the step. */
      observedMinGapMs: minGapMs,
      seriesMeasured,
      consistentWithRequested,
      ...(exact
        ? {}
        : consistentWithRequested
          ? {
              note:
                `Points came back no closer than ${minGapMs}ms apart, but every gap is a multiple of the ` +
                `requested ${requestedStepMs}ms step — which is what a sparse metric looks like at that step, ` +
                'since the datasource returns a point only where the range vector had samples. Consistent with the ' +
                'datasource honouring the request; not evidence of a different step, so read the numbers as they ' +
                'are.',
            }
          : {
              note:
                `Gaps between returned points share a divisor of ${gapGcdMs}ms, which is not a multiple of the ` +
                `requested ${requestedStepMs}ms — so the datasource did not evaluate at the requested step. Any ` +
                'range-vector function here (rate/increase/delta/*_over_time) answered at the step it did use, ' +
                'so read the numbers against that one.',
            }),
    },
  };
}

/**
 * Gap evidence across every series, with no requested step to compare it to —
 * for a replay that sent none and let Grafana's datasource default decide.
 * Undefined when no series had two distinct timestamps.
 */
export function observedSpacing(
  series: QuerySeries[],
): { observedGapGcdMs: number; observedMinGapMs: number; seriesMeasured: number } | undefined {
  const { gapGcdMs, minGapMs, seriesMeasured } = measureGaps(series);
  if (gapGcdMs === 0) return undefined;
  return { observedGapGcdMs: gapGcdMs, observedMinGapMs: minGapMs, seriesMeasured };
}

function measureGaps(series: QuerySeries[]): { gapGcdMs: number; minGapMs: number; seriesMeasured: number } {
  let gapGcdMs = 0;
  let minGapMs = Number.POSITIVE_INFINITY;
  let seriesMeasured = 0;

  for (const s of series) {
    const ts = [...new Set(s.points.map((p) => p.t))].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
    if (ts.length < 2) continue;
    seriesMeasured += 1;
    for (let i = 1; i < ts.length; i += 1) {
      const gap = ts[i]! - ts[i - 1]!;
      if (gap <= 0) continue;
      gapGcdMs = gcd(gapGcdMs, gap);
      if (gap < minGapMs) minGapMs = gap;
    }
  }
  return { gapGcdMs, minGapMs, seriesMeasured };
}
