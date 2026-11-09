import { describe, expect, it, vi } from 'vitest';
import { registerCorrelateLogs } from '../src/tools/correlateLogs.js';
import type { Config, LogConnection } from '../src/config.js';
import { GraylogApiError } from '../src/graylog/client.js';
import type { GraylogClient } from '../src/graylog/client.js';
import { fakeGraylogClient, fakeLogRegistry, fakeServer } from './toolTestHelpers.js';

const connections: LogConnection[] = [
  { id: 'log1', name: 'log1', sourceType: 'graylog', url: 'https://graylog.example.com', authType: 'token', token: 'x' },
];

function config(overrides: Partial<Config> = {}): Config {
  return {
    connections: [],
    logConnections: connections,
    tlsVerify: true,
    requestTimeoutMs: 1000,
    screenshotTimeoutMs: 45000,
    maxConcurrency: 4,
    maxLookbackHours: 720,
    maxDataPoints: 2000,
    maxLogLines: 500,
    redactionPatterns: [],
    dataDir: '.data',
    webhookPort: 4318,
    ...overrides,
  };
}

describe('correlate_logs tool', () => {
  it('runs a join query end to end and returns correlated/correlatedCount/url', async () => {
    const { client } = fakeGraylogClient({
      messagesBySelector: {
        'service:frontend': [{ message: { message: 'front', timestamp: '2026-01-01T00:00:00Z', source: 'frontend-host', request_id: 'r1' } }],
        'service:backend': [{ message: { message: 'back', timestamp: '2026-01-01T00:00:01Z', source: 'backend-host', request_id: 'r1' } }],
      },
    });
    const { server, call } = fakeServer();
    registerCorrelateLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config() } as never);

    const result = (await call('correlate_logs', {
      query: 'graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]',
      startsAtMs: 0,
      endsAtMs: 1,
    })) as { content: Array<{ text: string }> };

    const body = JSON.parse(result.content[0]!.text);
    expect(body.connectionId).toBe('log1');
    expect(body.correlatedCount).toBe(1);
    expect(body.correlated).toHaveLength(1);
    expect(body.correlated[0].joinValue).toBe('r1');
    expect(body.url).toContain('https://graylog.example.com/search');
  });

  it('returns an empty correlated array (not an error) when nothing matches', async () => {
    const { client } = fakeGraylogClient({
      messagesBySelector: {
        'service:frontend': [{ message: { message: 'front', timestamp: '2026-01-01T00:00:00Z', source: 'frontend-host', request_id: 'r1' } }],
        'service:backend': [],
      },
    });
    const { server, call } = fakeServer();
    registerCorrelateLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config() } as never);

    const result = (await call('correlate_logs', {
      query: 'graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]',
      startsAtMs: 0,
      endsAtMs: 1,
    })) as { content: Array<{ text: string }> };

    const body = JSON.parse(result.content[0]!.text);
    expect(body.correlatedCount).toBe(0);
    expect(body.correlated).toEqual([]);
  });

  it('returns an error result for a malformed join query rather than throwing past the tool boundary', async () => {
    const { client } = fakeGraylogClient({ messages: [] });
    const { server, call } = fakeServer();
    registerCorrelateLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config() } as never);

    const result = (await call('correlate_logs', {
      query: 'this is not a valid query',
      startsAtMs: 0,
      endsAtMs: 1,
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
  });

  it('clamps limit to maxLogLines before running the query', async () => {
    const { client, searchAbsolute } = fakeGraylogClient({
      messagesBySelector: { 'service:frontend': [], 'service:backend': [] },
    });
    const { server, call } = fakeServer();
    registerCorrelateLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config({ maxLogLines: 50 }) } as never);

    await call('correlate_logs', {
      query: 'graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]',
      startsAtMs: 0,
      endsAtMs: 1,
      limit: 9999,
    });
    expect(searchAbsolute).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  // Finding #2: an `unless` (anti-join) whose right side is truncated can report
  // a left event as "unmatched" when its match sits past the fetch cap — an
  // inverted answer. The tool must refuse rather than return it.
  it('hard-errors on an "unless" query when the right side is truncated', async () => {
    const { client } = fakeGraylogClient({
      messagesBySelector: {
        'service:frontend': [{ message: { message: 'f', timestamp: '2026-01-01T00:00:00Z', source: 'fe', request_id: 'r1' } }],
        // r1 matches on the right too, but only as the 3rd message; limit 2 hides it.
        'service:backend': [
          { message: { message: 'b', timestamp: '2026-01-01T00:00:00Z', source: 'be', request_id: 'r-a' } },
          { message: { message: 'b', timestamp: '2026-01-01T00:00:01Z', source: 'be', request_id: 'r-b' } },
          { message: { message: 'b', timestamp: '2026-01-01T00:00:02Z', source: 'be', request_id: 'r1' } },
        ],
      },
    });
    const { server, call } = fakeServer();
    registerCorrelateLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config({ maxLogLines: 2 }) } as never);

    const result = (await call('correlate_logs', {
      query: 'graylog(service:frontend)[5m] unless on(request_id) graylog(service:backend)[5m]',
      startsAtMs: 0,
      endsAtMs: 1,
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/unless.*truncated|truncated.*right/i);
  });

  // Issue #273: the engine collapses whitespace runs before parsing, quoted
  // values included. A double space inside the right side's quoted value used
  // to make the truncated selector the engine reported differ from the one
  // joinShape recorded, so the anti-join refusal was skipped and a partial
  // answer came back as complete, searched for a value nobody wrote.
  describe('whitespace the engine would rewrite', () => {
    const msg = (id: string) => ({ message: { message: 'm', timestamp: '2026-01-01T00:00:00Z', source: 's', request_id: id } });

    function setup(rightSelector: string) {
      const normalized = rightSelector.replace(/\s+/g, ' ');
      // r2 matches on the right, but only as the 2nd message; limit 1 hides it.
      const { client, searchAbsolute } = fakeGraylogClient({
        messagesBySelector: { 'service:frontend': [msg('r2')], [rightSelector]: [msg('r1'), msg('r2')], [normalized]: [msg('r1'), msg('r2')] },
      });
      const { server, call } = fakeServer();
      registerCorrelateLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config({ maxLogLines: 1 }) } as never);
      const run = async (query: string) =>
        (await call('correlate_logs', { query, startsAtMs: 0, endsAtMs: 1 })) as { content: Array<{ text: string }>; isError?: boolean };
      return { run, searchAbsolute };
    }

    it.each([
      ['a double space', 'service:"back  end"', '"back end"'],
      ['a tab', 'service:"back\tend"', '"back end"'],
    ])('refuses %s inside a quoted value, before any search, naming the rewrite', async (_label, right, sent) => {
      const { run, searchAbsolute } = setup(right);
      const result = await run(`graylog(service:frontend)[5m] unless on(request_id) graylog(${right})[5m]`);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/collapses every run of whitespace/);
      expect(result.content[0]!.text).toContain(`would run as ${JSON.stringify(`service:${sent}`)}`);
      expect(searchAbsolute).not.toHaveBeenCalled();
    });

    it('refuses a rewritten value on the left side too, and for joins other than unless', async () => {
      const { run, searchAbsolute } = setup('service:backend');
      const result = await run('graylog(service:"front  end")[5m] and on(request_id) graylog(service:backend)[5m]');
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('"service:\\"front  end\\"" would run as "service:\\"front end\\""');
      expect(searchAbsolute).not.toHaveBeenCalled();
    });

    it('still refuses the truncated anti-join when the quoted value has single spaces', async () => {
      const { run } = setup('service:"back end"');
      const result = await run('graylog(service:frontend)[5m] unless on(request_id) graylog(service:"back end")[5m]');
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/right-hand side of an "unless" anti-join was truncated/);
    });

    it('refuses a query that only parses after the engine normalizes it, since it cannot be compared', async () => {
      const { run, searchAbsolute } = setup('service:backend');
      // A non-breaking space: \s matches it, the join grammar does not.
      const result = await run('graylog(service:frontend)[5m]\u00a0and on(request_id) graylog(service:backend)[5m]');
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/only parses after that/);
      expect(searchAbsolute).not.toHaveBeenCalled();
    });

    it('does not refuse whitespace runs outside quotes, which the grammar already drops', async () => {
      const { run } = setup('service:backend AND level:error');
      const result = await run('graylog(service:frontend)[5m]\n  unless on(request_id)\n  graylog(service:backend  AND  level:error)[5m]');
      expect(result.isError).toBe(true);
      // The refusal that fires is the truncation one: the sides were identified.
      expect(result.content[0]!.text).toMatch(/right-hand side of an "unless" anti-join was truncated/);
    });
  });

  // Inner/`and` joins only under-count on truncation, so they return results but
  // must flag that a stream was truncated rather than implying a complete answer.
  it('surfaces a truncated flag (without erroring) for an "and" query with a truncated stream', async () => {
    const { client } = fakeGraylogClient({
      messagesBySelector: {
        'service:frontend': [{ message: { message: 'f', timestamp: '2026-01-01T00:00:00Z', source: 'fe', request_id: 'r1' } }],
        'service:backend': [
          { message: { message: 'b', timestamp: '2026-01-01T00:00:00Z', source: 'be', request_id: 'r-a' } },
          { message: { message: 'b', timestamp: '2026-01-01T00:00:01Z', source: 'be', request_id: 'r-b' } },
          { message: { message: 'b', timestamp: '2026-01-01T00:00:02Z', source: 'be', request_id: 'r1' } },
        ],
      },
    });
    const { server, call } = fakeServer();
    registerCorrelateLogs(server, { logRegistry: fakeLogRegistry(connections, client), config: config({ maxLogLines: 2 }) } as never);

    const result = (await call('correlate_logs', {
      query: 'graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]',
      startsAtMs: 0,
      endsAtMs: 1,
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text);
    expect(body.truncated).toBe(true);
    expect(body.streams.find((s: { selector: string }) => s.selector === 'service:backend')).toMatchObject({
      fetched: 2,
      total: 3,
      truncated: true,
    });
  });

  // Regression for #62/#88: correlate_logs' description tells the agent to put
  // request/trace ids into the query, so a GraylogApiError from a rejected
  // search carries those identifiers. The catch must redact them.
  it('redacts configured identifiers from a GraylogApiError before returning it to the model', async () => {
    const path = '/api/search/universal/absolute?query=customer%3Aacct-778899&from=x&to=y';
    const searchAbsolute = vi.fn(async () => {
      throw new GraylogApiError(
        `Graylog GET ${path} failed: 400 {"message":"cannot parse query customer:acct-778899"}`,
        400,
        path,
      );
    });
    const client = { searchAbsolute, listStreams: vi.fn() } as unknown as GraylogClient;
    const { server, call } = fakeServer();
    registerCorrelateLogs(server, {
      logRegistry: fakeLogRegistry(connections, client),
      config: config({ redactionPatterns: [/acct-\d+/i] }),
    } as never);

    const result = (await call('correlate_logs', {
      query: 'graylog(customer:acct-778899)[5m] and on(request_id) graylog(service:backend)[5m]',
      startsAtMs: 0,
      endsAtMs: 1,
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain('acct-778899');
    expect(result.content[0]!.text).toContain('[REDACTED]');
  });
});
