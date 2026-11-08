import { describe, expect, it } from 'vitest';
import { datasourceFloorMs, describeReplayStep, parseGrafanaIntervalMs, resolvePanelStep } from '../src/dashboards/panelStep.js';
import type { DatasourceInfo } from '../src/grafana/types.js';
import type { QuerySeries } from '../src/query/executor.js';

const HOUR = 3_600_000;
const window1h = { fromMs: 1_800_000_000_000, toMs: 1_800_000_000_000 + HOUR };

function resolve(
  panel: { interval?: string; maxDataPoints?: number },
  extra: { minIntervalMs?: number; window?: { fromMs: number; toMs: number }; datasource?: Pick<DatasourceInfo, 'type' | 'jsonData'> } = {},
) {
  return resolvePanelStep({
    panel,
    window: extra.window ?? window1h,
    variables: [{ name: 'iv', type: 'interval', current: { value: '5m' } }],
    overrides: {},
    configMaxDataPoints: 2000,
    minIntervalMs: extra.minIntervalMs,
    datasource: extra.datasource,
  });
}

const prometheus = (jsonData?: DatasourceInfo['jsonData']) => ({ type: 'prometheus', ...(jsonData ? { jsonData } : {}) });

function seriesAt(stepMs: number, count: number): QuerySeries[] {
  const points = Array.from({ length: count }, (_, i) => ({ t: window1h.fromMs + i * stepMs, v: 0 }));
  return [{ refId: 'A', labels: {}, points, pointsTotal: points.length }];
}

describe('parseGrafanaIntervalMs', () => {
  it.each([
    ['1m', 60_000],
    ['30s', 30_000],
    ['500ms', 500],
    ['1.5h', 5_400_000],
    ['1d', 86_400_000],
    ['1w', 604_800_000],
    ['1M', 2_592_000_000],
    ['1y', 31_536_000_000],
    ['>10s', 10_000],
    ['60', 60_000],
    [' 2m ', 120_000],
  ])('reads %j as %d ms', (text, ms) => {
    expect(parseGrafanaIntervalMs(text)).toBe(ms);
  });

  it.each(['', 'auto', '$iv', '1x', '1m30s', '-1m', '0s', 'm'])('refuses %j rather than guessing', (text) => {
    expect(parseGrafanaIntervalMs(text)).toBeUndefined();
  });
});

describe('resolvePanelStep', () => {
  it('uses the panel\'s min interval as the step when the window allows it (#200)', () => {
    expect(resolve({ interval: '1m' })).toEqual({ maxDataPoints: 2000, intervalMs: 60_000, floorMs: 60_000, source: 'panel', panelInterval: '1m' });
  });

  it('sends no step for a panel that declares none, leaving Grafana\'s datasource floor in charge', () => {
    expect(resolve({})).toEqual({ maxDataPoints: 2000, source: 'datasource-default' });
  });

  // span/maxDataPoints alone would say 5s here; Grafana's Prometheus backend floors at 15s.
  it('takes a Prometheus datasource\'s 15s default floor when the panel declares none', () => {
    expect(resolve({}, { datasource: prometheus({}) })).toEqual({ maxDataPoints: 2000, intervalMs: 15_000, floorMs: 15_000, source: 'datasource' });
  });

  it('takes a Prometheus datasource\'s configured scrape interval, and says which', () => {
    expect(resolve({}, { datasource: prometheus({ timeInterval: '1m' }) })).toEqual({
      maxDataPoints: 2000,
      intervalMs: 60_000,
      floorMs: 60_000,
      source: 'datasource',
      datasourceTimeInterval: '1m',
    });
  });

  it('lets the panel\'s own min interval win over the datasource\'s, even when finer, as Grafana does', () => {
    expect(resolve({ interval: '5s' }, { datasource: prometheus({ timeInterval: '30s' }) })).toMatchObject({ intervalMs: 5_000, source: 'panel' });
  });

  it('falls back to the datasource floor when the panel\'s interval cannot be read, and still reports it', () => {
    expect(resolve({ interval: '$missing' }, { datasource: prometheus({}) })).toMatchObject({
      intervalMs: 15_000,
      source: 'datasource',
      panelIntervalIgnored: '$missing',
    });
  });

  it('coarsens past the floor when the window would exceed maxDataPoints, as Grafana does', () => {
    const week = { fromMs: window1h.fromMs, toMs: window1h.fromMs + 7 * 24 * HOUR };
    const step = resolve({ interval: '1m' }, { window: week });
    expect(step.floorMs).toBe(60_000);
    expect(step.intervalMs).toBe(600_000);
    expect((week.toMs - week.fromMs) / step.intervalMs!).toBeLessThanOrEqual(2000);
  });

  it('substitutes a template variable in the panel interval', () => {
    expect(resolve({ interval: '$iv' })).toMatchObject({ intervalMs: 300_000, source: 'panel', panelInterval: '$iv' });
  });

  it('skips and reports an interval it cannot read, instead of guessing a step', () => {
    expect(resolve({ interval: '$missing' })).toEqual({
      maxDataPoints: 2000,
      source: 'datasource-default',
      panelInterval: '$missing',
      panelIntervalIgnored: '$missing',
    });
  });

  it('lets minIntervalMs replace the panel floor, in either direction', () => {
    expect(resolve({ interval: '1m' }, { minIntervalMs: 15_000 })).toMatchObject({ intervalMs: 15_000, source: 'minIntervalMs', panelInterval: '1m' });
    expect(resolve({}, { minIntervalMs: 300_000 })).toMatchObject({ intervalMs: 300_000, source: 'minIntervalMs' });
  });

  it('cannot use minIntervalMs to exceed the configured point budget', () => {
    expect(resolve({}, { minIntervalMs: 1 }).intervalMs).toBe(5_000);
  });

  it('honours a panel maxDataPoints below the configured cap, never above it', () => {
    expect(resolve({ maxDataPoints: 100 }).maxDataPoints).toBe(100);
    expect(resolve({ maxDataPoints: 100, interval: '1s' }).intervalMs).toBe(60_000);
    expect(resolve({ maxDataPoints: 50_000 }).maxDataPoints).toBe(2000);
  });
});

describe('datasourceFloorMs', () => {
  it('reads a Prometheus scrape interval, defaulting to 15s only when settings were listed and leave it unset', () => {
    expect(datasourceFloorMs(prometheus({ timeInterval: '30s' }))).toBe(30_000);
    expect(datasourceFloorMs(prometheus({}))).toBe(15_000);
    expect(datasourceFloorMs(prometheus({ timeInterval: '' }))).toBe(15_000);
  });

  it('answers nothing it cannot be sure of', () => {
    expect(datasourceFloorMs(prometheus())).toBeUndefined();
    expect(datasourceFloorMs(prometheus({ timeInterval: 'fast' }))).toBeUndefined();
    expect(datasourceFloorMs({ type: 'influxdb', jsonData: { timeInterval: '10s' } })).toBeUndefined();
    expect(datasourceFloorMs(undefined)).toBeUndefined();
  });
});

describe('describeReplayStep', () => {
  it('confirms a replay that came back at the requested step', () => {
    const report = describeReplayStep(resolve({ interval: '1m' }), seriesAt(60_000, 60));
    expect(report).toMatchObject({ source: 'panel', panelInterval: '1m', requestedMs: 60_000, observedGapGcdMs: 60_000, consistentWithRequested: true });
    expect(report.note).toBeUndefined();
    expect(report.sourceNote).toBeUndefined();
  });

  it('flags a datasource that evaluated finer than requested — the #200 shape', () => {
    const report = describeReplayStep(resolve({ interval: '1m' }), seriesAt(15_000, 241));
    expect(report.consistentWithRequested).toBe(false);
    expect(report.observedGapGcdMs).toBe(15_000);
    expect(report.note).toContain('did not evaluate at the requested step');
  });

  it('reports observed spacing and says who chose the step when none was requested', () => {
    const report = describeReplayStep(resolve({}), seriesAt(15_000, 241));
    expect(report).toMatchObject({ source: 'datasource-default', observedGapGcdMs: 15_000 });
    expect(report.requestedMs).toBeUndefined();
    expect(report.consistentWithRequested).toBeUndefined();
    expect(report.sourceNote).toContain('no min interval');
  });

  it('names the datasource floor when it set the step', () => {
    const report = describeReplayStep(resolve({}, { datasource: prometheus({}) }), seriesAt(15_000, 241));
    expect(report).toMatchObject({ source: 'datasource', requestedMs: 15_000, consistentWithRequested: true });
    expect(report.sourceNote).toContain('default scrape interval (15s');
  });

  it('says so when minIntervalMs moved the step off the panel\'s own', () => {
    const report = describeReplayStep(resolve({ interval: '1m' }, { minIntervalMs: 15_000 }), seriesAt(15_000, 241));
    expect(report.consistentWithRequested).toBe(true);
    expect(report.sourceNote).toContain('replacing the panel\'s own "1m"');
  });
});
