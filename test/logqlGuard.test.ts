import { describe, expect, it } from 'vitest';
import { classifyLogQL, classifyLogQLMetric } from '../src/query/logqlGuard.js';

function allowed(q: string) {
  const v = classifyLogQL(q);
  if (!v.allowed) throw new Error(`expected allowed, got refusal: ${v.reason}`);
  return v;
}

function refused(q: string): string {
  const v = classifyLogQL(q);
  if (v.allowed) throw new Error(`expected refusal for ${q}`);
  return v.reason;
}

describe('classifyLogQL', () => {
  describe('kind: log vs metric', () => {
    it.each([
      '{app="checkout"}',
      '{app="checkout", env=~"prod|staging"} |= "error"',
      '  ({app="checkout"})',
      // A realistic pipeline over double-encoded JSON: the braces in the
      // line_format template sit inside a raw string and must not decide anything.
      '{app=~"checkout|cart", namespace="shop"} |= `POST` | json | line_format `{{.payload}}` |~ `"status":"(500|503|timeout)"`',
    ])('%s is a log query', (q) => {
      expect(allowed(q).kind).toBe('log');
    });

    it.each([
      'count_over_time({app="checkout"}[5m])',
      'sum by (level) (rate({app="checkout"} | json [1m]))',
      '(sum(count_over_time({app="checkout"} |= "error" [1m])))',
      'quantile_over_time(0.99, {app="checkout"} | json | unwrap latency_ms [5m]) by (route)',
      'vector(0)',
      '1',
    ])('%s is a metric query', (q) => {
      expect(allowed(q).kind).toBe('metric');
    });
  });

  it('returns the statement verbatim (trimmed), never rewritten', () => {
    const q = '{app="checkout"} |= "a; b" # trailing comment';
    expect(allowed(`  ${q}\n`).statement).toBe(q);
  });

  it('ignores semicolons and brackets inside strings and comments', () => {
    expect(allowed('{path="/a;b(}"} |~ `[;{`').kind).toBe('log');
    expect(allowed('count_over_time({app="x"}[1m]) # ; ) {').kind).toBe('metric');
  });

  it('refuses a top-level semicolon', () => {
    expect(refused('{app="a"}; {app="b"}')).toMatch(/";"/);
  });

  it('refuses unbalanced brackets, naming the position', () => {
    expect(refused('count_over_time({app="a"}[5m]')).toMatch(/never closed/);
    expect(refused('{app="a"}}')).toMatch(/closes nothing/);
  });

  it('refuses an unterminated string, and says LogQL has no single-quoted form', () => {
    expect(refused('{app="a}')).toMatch(/unterminated string literal/);
    expect(refused('{app="a"} |= `oops')).toMatch(/unterminated raw string literal/);
    expect(refused("{app='a'} |= \"x")).toMatch(/no single-quoted form/);
  });

  it('refuses an empty or comment-only expression', () => {
    expect(refused('   ')).toMatch(/empty/);
    expect(refused('# just a comment')).toMatch(/empty/);
  });
});

describe('classifyLogQLMetric', () => {
  it('accepts a metric query', () => {
    expect(classifyLogQLMetric('sum(rate({app="a"}[1m]))')).toEqual({ allowed: true, statement: 'sum(rate({app="a"}[1m]))' });
  });

  it('refuses a log query and says how to count its lines instead', () => {
    const v = classifyLogQLMetric('{app="a"} |= "error"');
    expect(v.allowed).toBe(false);
    expect(v.allowed ? '' : v.reason).toMatch(/log query.*count_over_time/s);
  });

  it('passes a structural refusal through unchanged', () => {
    const v = classifyLogQLMetric('{app="a"');
    expect(v.allowed).toBe(false);
    expect(v.allowed ? '' : v.reason).toMatch(/unbalanced brackets/);
  });
});
