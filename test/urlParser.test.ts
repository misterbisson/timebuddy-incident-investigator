import { describe, expect, it } from 'vitest';
import { parseGrafanaTimeExpr, parseGrafanaUrl } from '../src/alerts/urlParser.js';

describe('parseGrafanaUrl', () => {
  it('parses a dashboard URL with panel, vars, and time range', () => {
    const url =
      'https://grafana.example.com/d/abc123/my-dashboard?orgId=1&viewPanel=7&from=now-1h&to=now&var-service=checkout&var-region=us-east-1&var-region=us-west-2';
    const parsed = parseGrafanaUrl(url);
    expect(parsed).toEqual({
      type: 'dashboard',
      uid: 'abc123',
      slug: 'my-dashboard',
      panelId: 7,
      vars: { service: ['checkout'], region: ['us-east-1', 'us-west-2'] },
      from: 'now-1h',
      to: 'now',
    });
  });

  it('parses a d-solo panel embed URL', () => {
    const parsed = parseGrafanaUrl('https://grafana.example.com/d-solo/abc123/my-dashboard?panelId=3&orgId=1');
    expect(parsed).toMatchObject({ type: 'dashboard', uid: 'abc123', panelId: 3 });
  });

  it("parses Grafana 11's scenes panel form (viewPanel=panel-3)", () => {
    const parsed = parseGrafanaUrl('https://grafana.example.com/d/abc123/my-dashboard?viewPanel=panel-3&orgId=1');
    expect(parsed).toMatchObject({ type: 'dashboard', uid: 'abc123', panelId: 3 });
  });

  // Each of these otherwise yields a plausible-looking id rather than an error:
  // "panel-" strips to "" and Number('') is 0 — an id no dashboard has, so it
  // lands right back on the "panel not found" symptom this parse exists to
  // remove — while the numeric-literal forms resolve to a real id and would
  // silently investigate some other panel.
  it.each([
    ['row-2', 'non-numeric'],
    ['panel-', 'empty after the prefix strip'],
    ['panel--2', 'negative'],
    ['0x10', 'hex literal'],
    ['1e3', 'exponent notation'],
    ['3.5', 'non-integer'],
  ])('throws on a malformed panel id (%s) rather than yielding a plausible-looking one', (raw) => {
    expect(() =>
      parseGrafanaUrl(`https://grafana.example.com/d/abc123/slug?viewPanel=${encodeURIComponent(raw)}`),
    ).toThrow(/Could not parse a panel id/);
  });

  it('parses an alert rule view URL', () => {
    const parsed = parseGrafanaUrl('https://grafana.example.com/alerting/grafana/rule-uid-1/view?orgId=1');
    expect(parsed).toEqual({ type: 'alert-rule', ruleUid: 'rule-uid-1' });
  });

  it('throws on an unrecognized URL', () => {
    expect(() => parseGrafanaUrl('https://grafana.example.com/explore')).toThrow(/Unrecognized/);
  });

  it('handles a dashboard URL with no query params', () => {
    const parsed = parseGrafanaUrl('https://grafana.example.com/d/xyz/slug');
    expect(parsed).toEqual({ type: 'dashboard', uid: 'xyz', slug: 'slug', panelId: undefined, vars: {}, from: undefined, to: undefined });
  });

  it('drops a var-* value containing query-breaking characters and reports it in rejectedVars', () => {
    const url =
      'https://grafana.example.com/d/abc123/my-dashboard?var-service=checkout&var-host=' +
      encodeURIComponent('x"} or up{job="evil');
    const parsed = parseGrafanaUrl(url);
    expect(parsed).toMatchObject({
      type: 'dashboard',
      vars: { service: ['checkout'] },
      rejectedVars: ['host'],
    });
  });

  it('keeps other safe values for a variable when only one of several is unsafe', () => {
    const url =
      'https://grafana.example.com/d/abc123/my-dashboard?var-region=us-east-1&var-region=' +
      encodeURIComponent('bad;value');
    const parsed = parseGrafanaUrl(url);
    expect(parsed.vars).toEqual({ region: ['us-east-1'] });
    expect(parsed.rejectedVars).toEqual(['region']);
  });
});

describe('parseGrafanaTimeExpr', () => {
  const nowMs = Date.parse('2026-07-07T12:00:00Z');

  it('resolves "now" to the reference time', () => {
    expect(parseGrafanaTimeExpr('now', nowMs)).toBe(nowMs);
  });

  it('resolves "now-<N><unit>" for seconds/minutes/hours/days/weeks', () => {
    expect(parseGrafanaTimeExpr('now-30s', nowMs)).toBe(nowMs - 30_000);
    expect(parseGrafanaTimeExpr('now-15m', nowMs)).toBe(nowMs - 15 * 60_000);
    expect(parseGrafanaTimeExpr('now-1h', nowMs)).toBe(nowMs - 3_600_000);
    expect(parseGrafanaTimeExpr('now-30d', nowMs)).toBe(nowMs - 30 * 86_400_000);
    expect(parseGrafanaTimeExpr('now-2w', nowMs)).toBe(nowMs - 14 * 86_400_000);
  });

  it('resolves months and years using calendar arithmetic, not a fixed-day approximation', () => {
    expect(parseGrafanaTimeExpr('now-1M', nowMs)).toBe(Date.parse('2026-06-07T12:00:00Z'));
    expect(parseGrafanaTimeExpr('now-1y', nowMs)).toBe(Date.parse('2025-07-07T12:00:00Z'));
  });

  it('parses an absolute epoch-ms numeric string', () => {
    expect(parseGrafanaTimeExpr('1780704000000', nowMs)).toBe(1780704000000);
  });

  it('parses an ISO 8601 date/time string', () => {
    expect(parseGrafanaTimeExpr('2026-06-08T00:00:00Z', nowMs)).toBe(Date.parse('2026-06-08T00:00:00Z'));
  });

  it('throws a clear error for an unsupported expression, e.g. Grafana rounding shorthand', () => {
    expect(() => parseGrafanaTimeExpr('now/d', nowMs)).toThrow(/Could not parse Grafana time param "now\/d"/);
  });
});
