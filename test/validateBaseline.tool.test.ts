import { describe, expect, it } from 'vitest';
import { registerValidateBaseline } from '../src/tools/validateBaseline.js';
import { registerDetectCorrelatedAnomalies } from '../src/tools/detectCorrelatedAnomalies.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { DashboardGetResponse, DsQueryResponse } from '../src/grafana/types.js';
import { fakeGrafanaClient, fakeRegistry, fakeServer } from './toolTestHelpers.js';

// #263: both analysis tools used to drop the executor's per-refId errors, so a
// rejected query — or one that returned log lines rather than numbers — came
// back as an empty result with nothing saying why.

const connections: GrafanaConnection[] = [{ id: 'test', name: 'test', url: 'https://grafana.example.com', authType: 'bearer', token: 'x' }];

function config(): Config {
  return {
    connections,
    tlsVerify: true,
    requestTimeoutMs: 1000,
    screenshotTimeoutMs: 45000,
    maxConcurrency: 4,
    maxLookbackHours: 720,
    maxDataPoints: 2000,
    redactionPatterns: [],
    dataDir: '.data',
    webhookPort: 4318,
  };
}

const dashboard: DashboardGetResponse = {
  dashboard: {
    uid: 'dash1',
    title: 'Checkout',
    version: 1,
    panels: [{ id: 1, title: 'Checkout logs', type: 'logs', targets: [{ refId: 'A', datasource: { uid: 'logs1' }, expr: '{app="checkout"}' }] }],
  },
  meta: {},
};

const logLinesResponse: DsQueryResponse = {
  results: {
    A: {
      frames: [
        {
          schema: {
            refId: 'A',
            fields: [
              { name: 'labels', type: 'other' },
              { name: 'Time', type: 'time' },
              { name: 'Line', type: 'string' },
            ],
          },
          data: { values: [[{ app: 'checkout' }], [1_780_000_000_000], ['GET /cart 500']] },
        },
      ],
    },
  },
};

const startsAtMs = Date.parse('2026-07-07T15:38:50Z');
const endsAtMs = Date.parse('2026-07-07T16:38:50Z');

describe('per-refId errors reach the caller', () => {
  it('validate_baseline reports the incident and control windows\' errors instead of an unexplained empty series list', async () => {
    const { client, queryDs } = fakeGrafanaClient({ dashboard });
    queryDs.mockImplementation(async () => logLinesResponse);
    const { server, call } = fakeServer();
    registerValidateBaseline(server, { registry: fakeRegistry(connections, client), config: config() } as never);

    const result = (await call('validate_baseline', {
      dashboardUid: 'dash1',
      panelId: 1,
      startsAtMs,
      endsAtMs,
      zThreshold: 3,
      connection: 'test',
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0]!.text);
    expect(body.series).toEqual([]);
    expect(body.errors.A).toMatch(/row\(s\) of text/);
    expect(Object.keys(body.controlErrors).length).toBeGreaterThan(0);
  });

  it('validate_baseline omits both fields when every query succeeded', async () => {
    const { client } = fakeGrafanaClient({ dashboard });
    const { server, call } = fakeServer();
    registerValidateBaseline(server, { registry: fakeRegistry(connections, client), config: config() } as never);
    const result = (await call('validate_baseline', {
      dashboardUid: 'dash1', panelId: 1, startsAtMs, endsAtMs, zThreshold: 3, connection: 'test',
    })) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0]!.text);
    expect(body.errors).toBeUndefined();
    expect(body.controlErrors).toBeUndefined();
  });

  it('detect_correlated_anomalies reports the primary panel\'s errors', async () => {
    const { client, queryDs } = fakeGrafanaClient({ dashboard });
    queryDs.mockImplementation(async () => logLinesResponse);
    const { server, call } = fakeServer();
    registerDetectCorrelatedAnomalies(server, { registry: fakeRegistry(connections, client), config: config() });

    const result = (await call('detect_correlated_anomalies', {
      primaryDashboardUid: 'dash1',
      primaryPanelId: 1,
      startsAtMs,
      endsAtMs,
      candidates: [],
      limit: 10,
      connection: 'test',
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0]!.text);
    expect(body.primaryErrors.A).toMatch(/row\(s\) of text/);
  });
});
