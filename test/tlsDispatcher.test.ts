import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrafanaClient } from '../src/grafana/client.js';
import { GraylogClient } from '../src/graylog/client.js';
import type { Config, GrafanaConnection, LogConnection } from '../src/config.js';

// Uses the REAL undici (no module mock): the point is the genuine async gap of
// `await import('undici')`, which is exactly the window the leak opened. A mock
// resolves too eagerly to reproduce it. We don't count constructions — we count
// how many DISTINCT dispatcher instances reach fetch across concurrent
// requests. The old code built one Agent per concurrent first request (and
// handed each its own), so several distinct dispatchers show up; the fix shares
// a single memoized Agent, so exactly one does (issue #154).

function config(): Config {
  return {
    connections: [],
    logConnections: [],
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
  };
}

const grafanaConnection: GrafanaConnection = {
  id: 'g',
  name: 'g',
  url: 'https://grafana.example.com',
  authType: 'bearer',
  token: 'x',
  tlsVerify: false, // opt out -> the undici Agent path is exercised
};

const logConnection: LogConnection = {
  id: 'l',
  name: 'l',
  sourceType: 'graylog',
  url: 'https://graylog.example.com',
  authType: 'token',
  token: 'x',
  tlsVerify: false,
};

function collectingFetch(dispatchers: Set<unknown>, body: string) {
  return vi.fn(async (_url: string, init: { dispatcher?: unknown }) => {
    dispatchers.add(init?.dispatcher);
    return new Response(body, { status: 200 });
  });
}

async function closeAll(dispatchers: Set<unknown>): Promise<void> {
  for (const d of dispatchers) {
    const close = (d as { close?: () => Promise<void> } | undefined)?.close;
    if (typeof close === 'function') await close.call(d);
  }
}

describe('TLS dispatcher reuse (tlsVerify=false)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GrafanaClient reuses one undici Agent across concurrent first requests (issue #154)', async () => {
    const dispatchers = new Set<unknown>();
    vi.stubGlobal('fetch', collectingFetch(dispatchers, '[]'));
    const client = new GrafanaClient(grafanaConnection, config());
    await Promise.all(Array.from({ length: 8 }, () => client.searchDashboards()));
    expect(dispatchers.size).toBe(1);
    // The single reused Agent is truthy (a dispatcher was actually applied).
    expect([...dispatchers][0]).toBeTruthy();
    await closeAll(dispatchers);
  });

  it('GraylogClient reuses one undici Agent across concurrent first requests (issue #154)', async () => {
    const dispatchers = new Set<unknown>();
    vi.stubGlobal('fetch', collectingFetch(dispatchers, JSON.stringify({ messages: [], total_results: 0 })));
    const client = new GraylogClient(logConnection, config());
    await Promise.all(Array.from({ length: 8 }, () => client.searchAbsolute({ query: '*', fromMs: 0, toMs: 1 })));
    expect(dispatchers.size).toBe(1);
    expect([...dispatchers][0]).toBeTruthy();
    await closeAll(dispatchers);
  });
});
