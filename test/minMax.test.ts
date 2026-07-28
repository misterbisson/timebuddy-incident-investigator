import { describe, expect, it } from 'vitest';
import { arrayMax, arrayMin } from '../src/util/minMax.js';

describe('arrayMin/arrayMax', () => {
  it('matches Math.min/Math.max on a small array', () => {
    const values = [3, -1, 4, 1, -5, 9, 2, 6];
    expect(arrayMin(values)).toBe(Math.min(...values));
    expect(arrayMax(values)).toBe(Math.max(...values));
    expect(arrayMin(values)).toBe(-5);
    expect(arrayMax(values)).toBe(9);
  });

  it('returns +/-Infinity for an empty array, like the arg-less Math calls', () => {
    expect(arrayMin([])).toBe(Infinity);
    expect(arrayMax([])).toBe(-Infinity);
  });

  it('handles a single element', () => {
    expect(arrayMin([42])).toBe(42);
    expect(arrayMax([42])).toBe(42);
  });

  it('does not throw on an array far larger than the argument-spread limit (issue #153)', () => {
    // Math.min(...values) / Math.max(...values) throw RangeError past the
    // engine's call-argument cap (~65k); the analysis functions are fed the
    // full un-downsampled series, which can be much larger. A linear scan must
    // not care about length.
    const n = 500_000;
    const values = new Array<number>(n);
    for (let i = 0; i < n; i++) values[i] = i - 123;
    expect(() => Math.min(...values)).toThrow(RangeError);
    expect(arrayMin(values)).toBe(-123);
    expect(arrayMax(values)).toBe(n - 1 - 123);
  });
});
