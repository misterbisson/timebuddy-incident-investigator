import { describe, expect, it } from 'vitest';
import { extractFromInfluxQL, extractFromPromQL, extractQueryInfo } from '../src/index-builder/extract.js';

describe('extractFromPromQL', () => {
  it('extracts the metric name from a selector expression', () => {
    const info = extractFromPromQL('rate(http_requests_total{service="checkout",status=~"5.."}[5m])');
    expect(info.metricNames).toContain('http_requests_total');
    expect(info.labels.service).toEqual(['checkout']);
    expect(info.labels.status).toEqual(['5..']);
  });

  it('extracts a bare metric name with no selector', () => {
    const info = extractFromPromQL('up');
    expect(info.metricNames).toEqual(['up']);
  });

  it('does not treat PromQL functions/aggregations as metric names', () => {
    const info = extractFromPromQL('sum(rate(node_cpu_seconds_total[5m])) by (instance)');
    expect(info.metricNames).toContain('node_cpu_seconds_total');
    expect(info.metricNames).not.toContain('sum');
    expect(info.metricNames).not.toContain('rate');
    expect(info.metricNames).not.toContain('by');
    expect(info.metricNames).not.toContain('instance');
  });
});

describe('extractFromInfluxQL', () => {
  it('extracts the measurement from a structured target', () => {
    const info = extractFromInfluxQL({ refId: 'A', measurement: 'cpu', tags: [{ key: 'host', operator: '=', value: 'db1' }] });
    expect(info.metricNames).toEqual(['cpu']);
    expect(info.labels.host).toEqual(['db1']);
  });

  it('extracts the measurement and tag filters from a raw query', () => {
    const info = extractFromInfluxQL({
      refId: 'A',
      query: `SELECT mean("value") FROM "autogen"."cpu" WHERE "host" = 'db1' AND time > now() - 1h GROUP BY time(1m)`,
    });
    expect(info.metricNames).toEqual(['cpu']);
    expect(info.labels.host).toEqual(['db1']);
  });
});

describe('extractQueryInfo', () => {
  it('dispatches to the Prometheus extractor when expr is present', () => {
    expect(extractQueryInfo({ refId: 'A', expr: 'up' }).metricNames).toEqual(['up']);
  });

  it('dispatches to the InfluxQL extractor when measurement is present', () => {
    expect(extractQueryInfo({ refId: 'A', measurement: 'cpu' }).metricNames).toEqual(['cpu']);
  });

  it('returns empty for a target with neither', () => {
    expect(extractQueryInfo({ refId: 'A' })).toEqual({ metricNames: [], labels: {} });
  });
});
