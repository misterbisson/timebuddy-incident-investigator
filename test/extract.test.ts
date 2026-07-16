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

  // #35: Grafana's InfluxQL editor stores the structured builder fields and
  // the raw Text-mode `query` string independently — editing one doesn't
  // regenerate the other — and `rawQuery` says which one Grafana actually
  // executes. A dashboard was found where a builder-mode panel's long-dead
  // `query` field still hardcoded the wrong platform tag; it was briefly
  // mistaken for a live bug before someone noticed `rawQuery: false`.
  it('ignores a stale "query" text field when rawQuery is false (builder mode is active)', () => {
    const info = extractFromInfluxQL({
      refId: 'A',
      rawQuery: false,
      measurement: 'cdsp_status',
      tags: [{ key: 'platform', operator: '=~', value: 'cds-kr-prd' }],
      // Stale text-mode leftover: wrong platform, never executed.
      query: `SELECT -1*"monitoring_status_code"+1 FROM "raw"."monit_process" WHERE "platform" = 'cds-eu-dev'`,
    });
    expect(info.metricNames).toEqual(['cdsp_status']);
    expect(info.labels.platform).toEqual(['cds-kr-prd']);
  });

  it('ignores stale builder fields when rawQuery is true (text mode is active)', () => {
    const info = extractFromInfluxQL({
      refId: 'A',
      rawQuery: true,
      // Stale builder-mode leftover: not what's executed.
      measurement: 'wrong_measurement',
      tags: [{ key: 'platform', operator: '=~', value: 'cds-eu-dev' }],
      query: `SELECT mean("value") FROM "cdsp_status" WHERE "platform" = 'cds-kr-prd'`,
    });
    expect(info.metricNames).toEqual(['cdsp_status']);
    expect(info.labels.platform).toEqual(['cds-kr-prd']);
  });

  it('falls back to reading whatever is present when rawQuery is absent (older dashboards saved before Grafana tracked it)', () => {
    const info = extractFromInfluxQL({
      refId: 'A',
      measurement: 'cpu',
      tags: [{ key: 'host', operator: '=', value: 'db1' }],
      query: `SELECT mean("value") FROM "mem" WHERE "region" = 'us-east-1'`,
    });
    expect(info.metricNames.sort()).toEqual(['cpu', 'mem']);
    expect(info.labels.host).toEqual(['db1']);
    expect(info.labels.region).toEqual(['us-east-1']);
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
