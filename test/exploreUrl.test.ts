import { describe, expect, it } from 'vitest';
import { buildExploreUrl } from '../src/grafana/urlBuilder.js';

const FROM = 1_760_000_000_000;
const TO = 1_760_003_600_000;

function panes(url: string): Record<string, any> {
  return JSON.parse(new URL(url).searchParams.get('panes')!);
}

describe('buildExploreUrl', () => {
  it('builds an /explore URL with the panes schema Grafana parses', () => {
    const url = buildExploreUrl('https://grafana.example.com', {
      datasourceUid: 'abc123',
      datasourceType: 'influxdb',
      query: 'SELECT mean("value") FROM "cpu"',
      fromMs: FROM,
      toMs: TO,
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://grafana.example.com/explore');
    expect(parsed.searchParams.get('schemaVersion')).toBe('1');
  });

  it('carries the query as raw text, not a rebuilt builder model', () => {
    const query = 'SELECT mean("value") FROM "cpu" WHERE "host" = \'web-01\'';
    const pane = Object.values(
      panes(buildExploreUrl('https://grafana.example.com', {
        datasourceUid: 'abc123',
        datasourceType: 'influxdb',
        query,
        fromMs: FROM,
        toMs: TO,
      })),
    )[0]!;
    expect(pane.queries[0].query).toBe(query);
    expect(pane.queries[0].rawQuery).toBe(true);
    // Both places Grafana looks for datasource identity.
    expect(pane.datasource).toBe('abc123');
    expect(pane.queries[0].datasource).toEqual({ type: 'influxdb', uid: 'abc123' });
  });

  it('always emits an absolute window, never a relative one', () => {
    // The whole point of the URL as an audit artifact: "now-1h" would describe a
    // different window every time someone opened it.
    const pane = Object.values(
      panes(buildExploreUrl('https://grafana.example.com', {
        datasourceUid: 'u',
        datasourceType: 'influxdb',
        query: 'SHOW MEASUREMENTS',
        fromMs: FROM,
        toMs: TO,
      })),
    )[0]!;
    expect(pane.range).toEqual({ from: String(FROM), to: String(TO) });
    expect(JSON.stringify(pane.range)).not.toContain('now');
  });

  it('omits orgId rather than defaulting it to 1', () => {
    const url = buildExploreUrl('https://grafana.example.com', {
      datasourceUid: 'u',
      datasourceType: 'influxdb',
      query: 'SHOW MEASUREMENTS',
      fromMs: FROM,
      toMs: TO,
    });
    expect(new URL(url).searchParams.has('orgId')).toBe(false);
  });

  it('includes orgId when the caller actually knows it', () => {
    const url = buildExploreUrl('https://grafana.example.com', {
      datasourceUid: 'u',
      datasourceType: 'influxdb',
      query: 'SHOW MEASUREMENTS',
      fromMs: FROM,
      toMs: TO,
      orgId: 7,
    });
    expect(new URL(url).searchParams.get('orgId')).toBe('7');
  });

  it('is byte-identical for the same query, so audit records are diffable', () => {
    const opts = {
      datasourceUid: 'u',
      datasourceType: 'influxdb',
      query: 'SHOW MEASUREMENTS',
      fromMs: FROM,
      toMs: TO,
    };
    expect(buildExploreUrl('https://grafana.example.com', opts)).toBe(
      buildExploreUrl('https://grafana.example.com', opts),
    );
  });

  it('tolerates a trailing slash on the base url', () => {
    const url = buildExploreUrl('https://grafana.example.com///', {
      datasourceUid: 'u',
      datasourceType: 'influxdb',
      query: 'SHOW MEASUREMENTS',
      fromMs: FROM,
      toMs: TO,
    });
    expect(url).toContain('https://grafana.example.com/explore');
  });

  it('survives a round trip through URL parsing with quotes intact', () => {
    // Grafana's own links percent-encode the panes JSON; a query full of quotes
    // is the normal case for InfluxQL, so this is the shape most likely to break.
    const query = 'SELECT "a b" FROM "m" WHERE "t" = \'v\'';
    const url = buildExploreUrl('https://grafana.example.com', {
      datasourceUid: 'u',
      datasourceType: 'influxdb',
      query,
      fromMs: FROM,
      toMs: TO,
    });
    expect(Object.values(panes(url))[0]!.queries[0].query).toBe(query);
  });
});
