import { describe, expect, it } from 'vitest';
import { parseGrafanaUrl } from '../src/alerts/urlParser.js';

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
});
