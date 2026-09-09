import { describe, expect, it } from 'vitest';
import { MAX_STEP_SECONDS, classifyPromQL, resolvePromqlStep, scanPromQL } from '../src/query/promqlGuard.js';

function allow(expr: string): string {
  const verdict = classifyPromQL(expr);
  if (!verdict.allowed) throw new Error(`expected allowed, got refusal: ${verdict.reason}`);
  return verdict.statement;
}

function refuse(expr: string): string {
  const verdict = classifyPromQL(expr);
  if (verdict.allowed) throw new Error(`expected refusal, got allowed: ${verdict.statement}`);
  return verdict.reason;
}

describe('classifyPromQL', () => {
  it('allows a plain selector and an aggregation', () => {
    expect(allow('up')).toBe('up');
    expect(allow('sum(rate(http_requests_total[5m])) by (job)')).toBe('sum(rate(http_requests_total[5m])) by (job)');
  });

  it('returns the expression verbatim, only trimmed', () => {
    // The tool executes verdict.statement, so "never rewrite" is the invariant
    // that makes every claim here a claim about the text that runs. A comment
    // stays put: PromQL handles `#` itself, and rewriting is what let an earlier
    // InfluxQL scanner silently execute a truncated query.
    const expr = 'count_over_time(app_action_total[1m]) # samples per minute';
    expect(allow(`  ${expr}  `)).toBe(expr);
  });

  it('allows the MetricsQL-only constructs the probe in #212 needs', () => {
    // The point of the whole request: submit a MetricsQL-only expression and let
    // the datasource's own accept/reject settle whether it is VictoriaMetrics.
    // A guard that only knew standard PromQL would refuse the probe and answer
    // the question wrongly, by refusing rather than by testing.
    expect(allow('up default 0')).toBe('up default 0');
    expect(allow('label_graphite_group({__name__="x"}, 1)')).toBe('label_graphite_group({__name__="x"}, 1)');
  });

  it('allows a `;` inside a string literal and inside a comment', () => {
    expect(allow('http_requests_total{path="/a;b"}')).toBe('http_requests_total{path="/a;b"}');
    expect(allow('up # note; really')).toBe('up # note; really');
  });

  it('refuses a top-level `;` as two queries in one call', () => {
    expect(refuse('up; down')).toContain('PromQL has no statement separator');
  });

  it('refuses an unterminated string literal', () => {
    expect(refuse('up{job="web')).toContain('unterminated string literal');
  });

  it('refuses an unterminated raw string literal', () => {
    expect(refuse('up{job=`web}')).toContain('unterminated raw string literal');
  });

  it('closes a raw string that ends with a backslash', () => {
    // Backticks are PromQL's raw form: a backslash there is a literal
    // backslash, so honouring escapes inside one would read the closing
    // delimiter as escaped and refuse a valid expression.
    expect(allow('up{job=`web\\`}')).toBe('up{job=`web\\`}');
  });

  it('treats a backslash-escaped quote as part of the literal', () => {
    expect(allow('up{job="a\\"b"}')).toBe('up{job="a\\"b"}');
  });

  it('refuses an empty or comment-only expression', () => {
    expect(refuse('   ')).toContain('empty');
    expect(refuse('# just a note')).toContain('empty');
  });

  it('refuses unbalanced brackets, naming which one', () => {
    expect(refuse('sum(rate(up[5m])')).toContain('is never closed');
    expect(refuse('sum(up))')).toContain('closes nothing');
    expect(refuse('rate(up[5m)')).toContain('closed by');
  });

  it('ignores brackets inside literals when balancing', () => {
    expect(allow('up{path=~"/(a|b)["}')).toBe('up{path=~"/(a|b)["}');
  });
});

describe('scanPromQL', () => {
  it('blanks literal contents and comments but keeps delimiters', () => {
    const { masked } = scanPromQL('up{job="a;b"} # x;y');
    expect(masked).toBe('up{job="   "}      ');
    expect(masked).not.toContain(';');
  });
});

describe('resolvePromqlStep', () => {
  const HOUR = 3_600_000;

  it('converts seconds to ms and reports the implied point count', () => {
    expect(resolvePromqlStep({ fromMs: 0, toMs: HOUR, stepSeconds: 60, maxDataPoints: 2000 })).toEqual({
      stepMs: 60_000,
      points: 61,
    });
  });

  it('refuses a step that would exceed MAX_DATA_POINTS, naming the smallest that fits', () => {
    // The actionable answer to "too fine" is the finest step this window can
    // carry, not just a rejection.
    expect(() => resolvePromqlStep({ fromMs: 0, toMs: 24 * HOUR, stepSeconds: 1, maxDataPoints: 2000 })).toThrow(
      /stepSeconds >= 44/,
    );
  });

  it('accepts the step it names as the minimum', () => {
    const span = 24 * HOUR;
    const minStep = Math.ceil(span / 1999 / 1000);
    const plan = resolvePromqlStep({ fromMs: 0, toMs: span, stepSeconds: minStep, maxDataPoints: 2000 });
    expect(plan.points).toBeLessThanOrEqual(2000);
  });

  it('caps stepSeconds at a day, so a step in milliseconds is a schema error not a one-point query', () => {
    expect(MAX_STEP_SECONDS).toBe(86_400);
  });
});
