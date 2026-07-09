import { describe, expect, it } from 'vitest';
import { resolveAlertContext } from '../src/alerts/ingest.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { RulerAlertRule } from '../src/grafana/types.js';

function fakeClient(rule?: RulerAlertRule): GrafanaClient {
  return {
    getAlertRuleByUid: async (uid: string) => {
      if (!rule) throw new Error(`no rule stubbed for ${uid}`);
      return rule;
    },
  } as unknown as GrafanaClient;
}

describe('resolveAlertContext', () => {
  it('resolves a webhook payload using the __dashboardUid__/__panelId__ annotations', async () => {
    const ctx = await resolveAlertContext(
      {
        webhookPayload: {
          alerts: [
            {
              fingerprint: 'fp1',
              status: { state: 'firing' },
              labels: { alertname: 'HighErrorRate', service: 'checkout' },
              annotations: { __dashboardUid__: 'dash1', __panelId__: '7' },
              startsAt: '2026-07-05T10:00:00Z',
              endsAt: '0001-01-01T00:00:00Z',
            },
          ],
        },
      },
      () => fakeClient(),
    );
    expect(ctx.source).toBe('webhook');
    expect(ctx.dashboardUid).toBe('dash1');
    expect(ctx.panelId).toBe(7);
    expect(ctx.labels.service).toBe('checkout');
    expect(ctx.warnings).toEqual([]);
  });

  it('selects an alert by fingerprint out of several in a webhook payload', async () => {
    const ctx = await resolveAlertContext(
      {
        webhookPayload: {
          alerts: [
            { fingerprint: 'fp1', status: { state: 'firing' }, labels: { alertname: 'A' }, annotations: {}, startsAt: 't1', endsAt: 't2' },
            { fingerprint: 'fp2', status: { state: 'firing' }, labels: { alertname: 'B' }, annotations: {}, startsAt: 't3', endsAt: 't4' },
          ],
        },
        fingerprint: 'fp2',
      },
      () => fakeClient(),
    );
    expect(ctx.alertName).toBe('B');
  });

  it('warns when a pasted alert has no dashboard/panel link', async () => {
    const ctx = await resolveAlertContext(
      {
        alertJson: {
          fingerprint: 'fp1',
          status: { state: 'firing' },
          labels: { alertname: 'NoLink' },
          annotations: {},
          startsAt: '2026-07-05T10:00:00Z',
          endsAt: '0001-01-01T00:00:00Z',
        },
      },
      () => fakeClient(),
    );
    expect(ctx.dashboardUid).toBeUndefined();
    expect(ctx.warnings.length).toBeGreaterThan(0);
  });

  it('recovers a dashboard/panel link from a panelURL when annotations are absent', async () => {
    const ctx = await resolveAlertContext(
      {
        alertJson: {
          fingerprint: 'fp1',
          status: { state: 'firing' },
          labels: { alertname: 'A' },
          annotations: {},
          startsAt: 't1',
          endsAt: 't2',
          panelURL: 'https://grafana.example.com/d/dash2/slug?viewPanel=3&var-service=checkout',
        },
      },
      () => fakeClient(),
    );
    expect(ctx.dashboardUid).toBe('dash2');
    expect(ctx.panelId).toBe(3);
    expect(ctx.variables).toEqual({ service: ['checkout'] });
  });

  it('resolves a dashboard URL directly without hitting the client', async () => {
    const ctx = await resolveAlertContext(
      { url: 'https://grafana.example.com/d/dash3/slug?viewPanel=9&var-host=db1' },
      () => fakeClient(),
    );
    expect(ctx.dashboardUid).toBe('dash3');
    expect(ctx.panelId).toBe(9);
    expect(ctx.variables).toEqual({ host: ['db1'] });
  });

  it('drops a var-* override with query-breaking characters and warns, rather than passing it through', async () => {
    const injected = encodeURIComponent('x"} or up{job="evil');
    const ctx = await resolveAlertContext(
      { url: `https://grafana.example.com/d/dash3/slug?viewPanel=9&var-host=${injected}` },
      () => fakeClient(),
    );
    expect(ctx.variables).toEqual({});
    expect(ctx.warnings.some((w) => w.includes('host'))).toBe(true);
  });

  it('drops an unsafe var-* value recovered from a pasted alert panelURL and warns', async () => {
    const injected = encodeURIComponent("bad';drop");
    const ctx = await resolveAlertContext(
      {
        alertJson: {
          fingerprint: 'fp1',
          status: { state: 'firing' },
          labels: { alertname: 'A' },
          annotations: {},
          startsAt: 't1',
          endsAt: 't2',
          panelURL: `https://grafana.example.com/d/dash2/slug?viewPanel=3&var-service=checkout&var-host=${injected}`,
        },
      },
      () => fakeClient(),
    );
    expect(ctx.variables).toEqual({ service: ['checkout'] });
    expect(ctx.warnings.some((w) => w.includes('host'))).toBe(true);
  });

  it('stamps panelURL from a bare panel URL so connection auto-resolution has a hostname to match', async () => {
    const ctx = await resolveAlertContext(
      { url: 'https://grafana.example.com/d/dash3/slug?viewPanel=9&var-host=db1' },
      () => fakeClient(),
    );
    expect(ctx.panelURL).toBe('https://grafana.example.com/d/dash3/slug?viewPanel=9&var-host=db1');
    expect(ctx.dashboardURL).toBeUndefined();
  });

  it('stamps dashboardURL (not panelURL) from a bare dashboard URL with no viewPanel', async () => {
    const ctx = await resolveAlertContext(
      { url: 'https://grafana.example.com/d/dash5/slug?var-host=db1' },
      () => fakeClient(),
    );
    expect(ctx.dashboardURL).toBe('https://grafana.example.com/d/dash5/slug?var-host=db1');
    expect(ctx.panelURL).toBeUndefined();
  });

  it('resolves an alert-rule URL by fetching the rule definition', async () => {
    const rule: RulerAlertRule = {
      uid: 'rule1',
      title: 'High latency',
      condition: 'C',
      data: [
        { refId: 'A', datasourceUid: 'prom1', model: { expr: 'up' } },
        {
          refId: 'C',
          model: { conditions: [{ evaluator: { type: 'gt', params: [0.9] } }] },
        },
      ],
      annotations: { __dashboardUid__: 'dash4', __panelId__: '2' },
      labels: { service: 'checkout' },
    };
    const ctx = await resolveAlertContext(
      { url: 'https://grafana.example.com/alerting/grafana/rule1/view' },
      () => fakeClient(rule),
    );
    expect(ctx.ruleUid).toBe('rule1');
    expect(ctx.dashboardUid).toBe('dash4');
    expect(ctx.panelId).toBe(2);
    expect(ctx.threshold).toBe('gt 0.9');
    expect(ctx.labels.service).toBe('checkout');
  });

  it('warns when an alert rule has no linked dashboard', async () => {
    const rule: RulerAlertRule = {
      uid: 'rule2',
      title: 'No dashboard rule',
      condition: 'A',
      data: [{ refId: 'A', model: {} }],
    };
    const ctx = await resolveAlertContext(
      { url: 'https://grafana.example.com/alerting/grafana/rule2/view' },
      () => fakeClient(rule),
    );
    expect(ctx.dashboardUid).toBeUndefined();
    expect(ctx.warnings.length).toBeGreaterThan(0);
  });

  it('throws when none of webhookPayload, alertJson, or url are provided', async () => {
    await expect(resolveAlertContext({}, () => fakeClient())).rejects.toThrow(/Must provide one of/);
  });
});
