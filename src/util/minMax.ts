/**
 * Linear-scan min/max over a numeric array.
 *
 * These exist because `Math.min(...values)` / `Math.max(...values)` spread the
 * whole array as *call arguments*, and the analysis functions here run on the
 * full, un-downsampled series on purpose (a raw InfluxQL target with no
 * `GROUP BY time()` yields ~21.6k points over 6h, and far more within the
 * max-lookback cap — see query/executor.ts). Spreading tens of thousands of
 * arguments risks `RangeError: Maximum call stack size exceeded` (issue #153).
 *
 * Behaviour matches Math.min/Math.max for the inputs these callers pass:
 * an empty array returns +Infinity (min) / -Infinity (max), the same as the
 * arg-less Math calls. Callers here pass pre-filtered finite numbers, so the
 * NaN-propagation difference (Math.min returns NaN if any element is NaN; a
 * comparison loop skips it) never comes into play.
 */
export function arrayMin(values: number[]): number {
  let min = Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v < min) min = v;
  }
  return min;
}

export function arrayMax(values: number[]): number {
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v > max) max = v;
  }
  return max;
}
