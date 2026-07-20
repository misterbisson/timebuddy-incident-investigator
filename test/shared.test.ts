import { describe, expect, it, vi } from 'vitest';
import { dashboardUrlFor, epochMsSchema, resolveTargetDatasource, toolErrorResult, windowSizeWarning } from '../src/tools/shared.js';
import type { Config } from '../src/config.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { ConnectionRegistry } from '../src/grafana/registry.js';
import type { GrafanaConnection } from '../src/config.js';
import type { TemplateVariable } from '../src/grafana/types.js';

function fakeClient(datasources: Array<{ uid: string; name: string }>): { client: GrafanaClient; listDatasources: ReturnType<typeof vi.fn> } {
  const listDatasources = vi.fn(async () => datasources.map((d) => ({ ...d, id: 1, type: 'prometheus' })));
  return { client: { listDatasources } as unknown as GrafanaClient, listDatasources };
}

function fakeRegistry(connections: GrafanaConnection[]): ConnectionRegistry {
  return { list: () => connections } as unknown as ConnectionRegistry;
}

describe('resolveTargetDatasource', () => {
  it('passes through a ref that is not a variable reference without touching the client', async () => {
    const { client, listDatasources } = fakeClient([]);
    const result = await resolveTargetDatasource(client, 'prom1', [], {});
    expect(result).toBe('prom1');
    expect(listDatasources).not.toHaveBeenCalled();
  });

  it('passes through undefined without touching the client', async () => {
    const { client, listDatasources } = fakeClient([]);
    expect(await resolveTargetDatasource(client, undefined, [], {})).toBeUndefined();
    expect(listDatasources).not.toHaveBeenCalled();
  });

  it('resolves a $datasource variable whose current value is already a real UID', async () => {
    const { client } = fakeClient([{ uid: 'prom1', name: 'Prometheus' }]);
    const variables: TemplateVariable[] = [{ name: 'datasource', type: 'datasource', current: { value: 'prom1' } }];
    expect(await resolveTargetDatasource(client, '$datasource', variables, {})).toBe('prom1');
  });

  it('falls back to a name lookup when the variable resolves to a datasource name rather than a UID', async () => {
    const { client } = fakeClient([{ uid: 'prom1', name: 'Griffin-Prometheus' }]);
    const variables: TemplateVariable[] = [{ name: 'DS_PROMETHEUS', type: 'datasource', current: { value: 'Griffin-Prometheus' } }];
    expect(await resolveTargetDatasource(client, '${DS_PROMETHEUS}', variables, {})).toBe('prom1');
  });

  it('returns the unresolved name as-is when no datasource matches it by UID or name', async () => {
    const { client } = fakeClient([{ uid: 'prom1', name: 'Prometheus' }]);
    const variables: TemplateVariable[] = [{ name: 'datasource', type: 'datasource', current: { value: 'gone' } }];
    expect(await resolveTargetDatasource(client, '$datasource', variables, {})).toBe('gone');
  });

  it('returns undefined when the variable itself is not defined on the dashboard', async () => {
    const { client } = fakeClient([{ uid: 'prom1', name: 'Prometheus' }]);
    expect(await resolveTargetDatasource(client, '$missing', [], {})).toBeUndefined();
  });
});

describe('epochMsSchema', () => {
  it('passes a raw epoch-ms number through unchanged', () => {
    expect(epochMsSchema.parse(1780704000000)).toBe(1780704000000);
  });

  it('parses an ISO 8601 date/time string into epoch ms', () => {
    expect(epochMsSchema.parse('2026-06-08T00:00:00Z')).toBe(Date.parse('2026-06-08T00:00:00Z'));
  });

  it('parses a bare date (no time) string into epoch ms', () => {
    expect(epochMsSchema.parse('2026-06-08')).toBe(Date.parse('2026-06-08'));
  });

  it('rejects a string that is not a parseable date, with a clear message', () => {
    expect(() => epochMsSchema.parse('not-a-date')).toThrowError(/Could not parse.*not-a-date.*as a date/);
  });
});

describe('dashboardUrlFor', () => {
  const connection: GrafanaConnection = { id: 'eu-prd', name: 'eu-prd', url: 'https://grafana.example.com', authType: 'bearer', token: 'x' };

  it('builds a URL using the resolved connection\'s base url', () => {
    const url = dashboardUrlFor(fakeRegistry([connection]), 'eu-prd', 'abc123', { panelId: 7 });
    expect(url).toBe('https://grafana.example.com/d/abc123?viewPanel=7');
  });

  it('returns undefined when the connection id is not found, rather than throwing', () => {
    expect(dashboardUrlFor(fakeRegistry([connection]), 'missing', 'abc123')).toBeUndefined();
  });
});

describe('toolErrorResult', () => {
  /** Config with only the fields toolErrorResult reads. */
  const cfg = (redactionPatterns: RegExp[] = []) => ({ redactionPatterns }) as unknown as Config;
  const textOf = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

  it('formats a bare error message when no url is available', () => {
    const result = toolErrorResult(new Error('boom'), cfg());
    expect(textOf(result)).toBe('Error: boom');
    expect(result.isError).toBe(true);
  });

  it('appends the dashboard/panel url when one was already resolved', () => {
    const result = toolErrorResult(new Error('timed out'), cfg(), 'https://grafana.example.com/d/abc123?viewPanel=4');
    expect(textOf(result)).toBe(
      'Error: timed out\n\nDashboard/panel: https://grafana.example.com/d/abc123?viewPanel=4',
    );
  });

  it('handles a non-Error thrown value', () => {
    expect(textOf(toolErrorResult('plain string error', cfg()))).toBe('Error: plain string error');
  });

  // The reported leak: grafana/client.ts embeds up to 500 chars of the raw
  // response body in GrafanaApiError, and a datasource rejecting a query
  // echoes back the query text with template variables already substituted.
  it('redacts a configured pattern out of an echoed datasource error', () => {
    const err = new Error(
      'Grafana POST /api/ds/query failed: 400 error parsing query: ' +
        'SELECT mean("v") FROM "m" WHERE "customer" = \'acme-corp-4417\'',
    );
    const text = textOf(toolErrorResult(err, cfg([/acme-corp-\d+/g])));
    expect(text).not.toContain('acme-corp-4417');
    expect(text).toContain('Grafana POST /api/ds/query failed: 400');
  });

  // Boundary worth pinning: redact() masks secret-shaped *keys* when walking an
  // object, but redactString only ever applies the configured patterns — so
  // free text is untouched with none configured. That's true of success paths
  // too, and predates this change; the point here is that routing errors
  // through redact() buys the configured-pattern guarantee and nothing more.
  it('leaves error text alone when no redaction patterns are configured', () => {
    const text = textOf(toolErrorResult(new Error('failed with token=abcd1234secretvalue'), cfg()));
    expect(text).toBe('Error: failed with token=abcd1234secretvalue');
  });

  it('redacts the url too, not just the message', () => {
    const text = textOf(
      toolErrorResult(new Error('boom'), cfg([/acme-corp-\d+/g]), 'https://grafana.example.com/d/abc?var-cust=acme-corp-4417'),
    );
    expect(text).not.toContain('acme-corp-4417');
  });
});

describe('windowSizeWarning', () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  it('returns undefined when endsAtMs was explicitly provided, however large the window', () => {
    expect(windowSizeWarning(0, 30 * DAY, 30 * DAY)).toBeUndefined();
  });

  it('returns undefined when endsAtMs defaulted but the resulting window is under 24h', () => {
    expect(windowSizeWarning(0, undefined, 5 * HOUR)).toBeUndefined();
  });

  it('warns when endsAtMs defaulted and the resulting window exceeds 24h', () => {
    const warning = windowSizeWarning(0, undefined, 8 * DAY);
    expect(warning).toMatch(/endsAtMs was not provided/);
    expect(warning).toMatch(/8\.0-day window/);
  });
});
