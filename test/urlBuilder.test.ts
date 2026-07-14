import { describe, expect, it } from 'vitest';
import { buildDashboardUrl, buildInspectDataUrl, buildSoloPanelUrl } from '../src/grafana/urlBuilder.js';

describe('buildDashboardUrl', () => {
  it('builds a bare dashboard link with no options', () => {
    expect(buildDashboardUrl('https://grafana.example.com', 'abc123')).toBe('https://grafana.example.com/d/abc123');
  });

  it('strips a trailing slash from the base URL', () => {
    expect(buildDashboardUrl('https://grafana.example.com/', 'abc123')).toBe('https://grafana.example.com/d/abc123');
  });

  it('adds viewPanel for a specific panel', () => {
    const url = new URL(buildDashboardUrl('https://grafana.example.com', 'abc123', { panelId: 7 }));
    expect(url.pathname).toBe('/d/abc123');
    expect(url.searchParams.get('viewPanel')).toBe('7');
  });

  it('adds from/to for a specific time window', () => {
    const url = new URL(buildDashboardUrl('https://grafana.example.com', 'abc123', { fromMs: 1000, toMs: 2000 }));
    expect(url.searchParams.get('from')).toBe('1000');
    expect(url.searchParams.get('to')).toBe('2000');
  });

  it('adds var-* params for each variable value, supporting multi-value variables', () => {
    const url = new URL(
      buildDashboardUrl('https://grafana.example.com', 'abc123', { variables: { service: ['checkout', 'payments'] } }),
    );
    expect(url.searchParams.getAll('var-service')).toEqual(['checkout', 'payments']);
  });

  it('percent-encodes a dashboard UID with special characters', () => {
    const url = buildDashboardUrl('https://grafana.example.com', 'a/b c');
    expect(url).toBe('https://grafana.example.com/d/a%2Fb%20c');
  });

  it('combines panelId, time window, and variables in one URL', () => {
    const url = new URL(
      buildDashboardUrl('https://grafana.example.com', 'abc123', {
        panelId: 7,
        fromMs: 1000,
        toMs: 2000,
        variables: { region: ['eu-central-1'] },
      }),
    );
    expect(url.pathname).toBe('/d/abc123');
    expect(url.searchParams.get('viewPanel')).toBe('7');
    expect(url.searchParams.get('from')).toBe('1000');
    expect(url.searchParams.get('to')).toBe('2000');
    expect(url.searchParams.get('var-region')).toBe('eu-central-1');
  });
});

describe('buildSoloPanelUrl', () => {
  it('builds a /d-solo/:uid link with panelId set', () => {
    const url = new URL(buildSoloPanelUrl('https://grafana.example.com', 'abc123', 7));
    expect(url.pathname).toBe('/d-solo/abc123');
    expect(url.searchParams.get('panelId')).toBe('7');
  });

  it('strips a trailing slash from the base URL', () => {
    expect(buildSoloPanelUrl('https://grafana.example.com/', 'abc123', 7)).toBe(
      'https://grafana.example.com/d-solo/abc123?panelId=7',
    );
  });

  it('adds from/to and var-* params, supporting multi-value variables', () => {
    const url = new URL(
      buildSoloPanelUrl('https://grafana.example.com', 'abc123', 7, {
        fromMs: 1000,
        toMs: 2000,
        variables: { service: ['checkout', 'payments'] },
      }),
    );
    expect(url.searchParams.get('from')).toBe('1000');
    expect(url.searchParams.get('to')).toBe('2000');
    expect(url.searchParams.getAll('var-service')).toEqual(['checkout', 'payments']);
  });

  it('percent-encodes a dashboard UID with special characters', () => {
    const url = buildSoloPanelUrl('https://grafana.example.com', 'a/b c', 7);
    expect(url).toBe('https://grafana.example.com/d-solo/a%2Fb%20c?panelId=7');
  });
});

describe('buildInspectDataUrl', () => {
  it('builds the full (chrome-included) viewPanel link with the Inspect drawer opened on the Data tab', () => {
    const url = new URL(buildInspectDataUrl('https://grafana.example.com', 'abc123', 7));
    expect(url.pathname).toBe('/d/abc123');
    expect(url.searchParams.get('viewPanel')).toBe('7');
    expect(url.searchParams.get('inspect')).toBe('7');
    expect(url.searchParams.get('inspectTab')).toBe('data');
  });

  it('carries through from/to and var-* params alongside the inspect params', () => {
    const url = new URL(
      buildInspectDataUrl('https://grafana.example.com', 'abc123', 7, {
        fromMs: 1000,
        toMs: 2000,
        variables: { service: ['checkout'] },
      }),
    );
    expect(url.searchParams.get('from')).toBe('1000');
    expect(url.searchParams.get('to')).toBe('2000');
    expect(url.searchParams.get('var-service')).toBe('checkout');
    expect(url.searchParams.get('inspect')).toBe('7');
  });
});
