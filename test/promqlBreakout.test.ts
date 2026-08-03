import { describe, expect, it } from 'vitest';
import { applyPromqlFilter, applyPromqlGroupBy, RewriteFailure } from '../src/dashboards/promqlBreakout.js';

describe('applyPromqlFilter — filter (value present)', () => {
  it('injects a fresh {key="value"} block onto a bare selector', () => {
    expect(applyPromqlFilter('node_load1', 'host', 'web-07')).toBe('node_load1{host="web-07"}');
  });

  it('inserts the range vector after the injected block', () => {
    expect(applyPromqlFilter('rate(http_requests_total[5m])', 'instance', 'web-07'))
      .toBe('rate(http_requests_total{instance="web-07"}[5m])');
  });

  it('appends into an existing non-empty {...} block', () => {
    expect(applyPromqlFilter('up{job="node"}', 'instance', 'web-07')).toBe('up{job="node",instance="web-07"}');
  });

  it('fills an existing empty {} block with no leading comma', () => {
    expect(applyPromqlFilter('up{}', 'instance', 'web-07')).toBe('up{instance="web-07"}');
  });

  it('is idempotent — re-applying the same key=value filter is a no-op', () => {
    const once = applyPromqlFilter('up', 'instance', 'web-07');
    expect(applyPromqlFilter(once, 'instance', 'web-07')).toBe(once);
  });

  it('throws rather than silently overriding a conflicting existing constraint on the same label', () => {
    expect(() => applyPromqlFilter('up{instance="other-host"}', 'instance', 'web-07')).toThrow(RewriteFailure);
    expect(() => applyPromqlFilter('up{instance="other-host"}', 'instance', 'web-07')).toThrow(/already constrained/);
  });

  it('escapes a value containing a quote and a backslash', () => {
    expect(applyPromqlFilter('up', 'path', 'C:\\logs\\"weird".txt'))
      .toBe('up{path="C:\\\\logs\\\\\\"weird\\".txt"}');
  });

  it('filters every selector across a binary expression combining two metrics', () => {
    expect(applyPromqlFilter('sum(rate(a[5m])) / sum(rate(b[5m]))', 'instance', 'web-07'))
      .toBe('sum(rate(a{instance="web-07"}[5m])) / sum(rate(b{instance="web-07"}[5m]))');
  });

  it('does not mistake a by(...) grouping label for a metric selector', () => {
    expect(applyPromqlFilter('sum by (job) (up)', 'instance', 'web-07'))
      .toBe('sum by (job) (up{instance="web-07"})');
  });

  it('does not mistake string-literal contents (e.g. label_replace args) for a metric selector', () => {
    const expr = 'label_replace(up, "host", "$1", "instance", "web-(.*)")';
    const out = applyPromqlFilter(expr, 'region', 'us-east');
    expect(out).toBe('label_replace(up{region="us-east"}, "host", "$1", "instance", "web-(.*)")');
  });

  it('rejects a label key that is not a valid PromQL identifier (injection guard)', () => {
    expect(() => applyPromqlFilter('up', 'host"} or evil{x', 'web-07')).toThrow(RewriteFailure);
    expect(() => applyPromqlFilter('up', 'host"} or evil{x', 'web-07')).toThrow(/isn't a valid PromQL label name/);
  });

  it('throws when no metric selector exists at all', () => {
    expect(() => applyPromqlFilter('1', 'host', 'web-07')).toThrow(/no metric selector found/);
  });

  it('throws on an unterminated quoted string', () => {
    expect(() => applyPromqlFilter('up{job="node}', 'host', 'web-07')).toThrow(/unterminated quoted string/);
  });
});

describe('applyPromqlGroupBy — group by (value omitted)', () => {
  it('injects a fresh by (key) clause when the aggregation has no modifier', () => {
    expect(applyPromqlGroupBy('sum(rate(x[5m]))', 'instance')).toBe('sum by (instance) (rate(x[5m]))');
  });

  it('appends to an existing prefix by(...) clause', () => {
    expect(applyPromqlGroupBy('sum by (job) (up)', 'instance')).toBe('sum by (job, instance) (up)');
  });

  it('appends to an existing postfix by(...) clause', () => {
    expect(applyPromqlGroupBy('sum(up) by (job)', 'instance')).toBe('sum(up) by (job, instance)');
  });

  it('is idempotent — grouping by a key already present in by(...) is a no-op', () => {
    expect(applyPromqlGroupBy('sum by (instance) (up)', 'instance')).toBe('sum by (instance) (up)');
  });

  it('removes the key from an existing without(...) list, which is what makes it appear as its own series', () => {
    expect(applyPromqlGroupBy('sum without (instance) (up)', 'instance')).toBe('sum without () (up)');
  });

  it('leaves a without(...) clause alone when the key is not excluded — already implicitly broken out', () => {
    expect(applyPromqlGroupBy('sum without (job) (up)', 'instance')).toBe('sum without (job) (up)');
  });

  it('rewrites every aggregation across a binary expression', () => {
    expect(applyPromqlGroupBy('sum(rate(a[5m])) / sum(rate(b[5m]))', 'instance'))
      .toBe('sum by (instance) (rate(a[5m])) / sum by (instance) (rate(b[5m]))');
  });

  it('reaches an aggregation nested inside another function call', () => {
    expect(applyPromqlGroupBy('histogram_quantile(0.99, sum(rate(x_bucket[5m])) by (le))', 'host'))
      .toBe('histogram_quantile(0.99, sum(rate(x_bucket[5m])) by (le, host))');
  });

  it('rejects a label key that is not a valid PromQL identifier (injection guard)', () => {
    expect(() => applyPromqlGroupBy('sum(up)', 'a) malicious(')).toThrow(/isn't a valid PromQL label name/);
  });

  it('throws when the expression has no aggregation operator at all', () => {
    expect(() => applyPromqlGroupBy('up{job="node"}', 'instance')).toThrow(/no aggregation operator/);
  });

  it('throws on unbalanced parentheses', () => {
    expect(() => applyPromqlGroupBy('sum(rate(x[5m])', 'instance')).toThrow(/unbalanced parentheses/);
  });
});
