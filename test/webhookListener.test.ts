import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWebhookListener } from '../src/webhook/listener.js';
import type { Config } from '../src/config.js';

let dataDir: string;
let server: Server | undefined;

function config(overrides: Partial<Config> = {}): Config {
  return {
    connections: [],
    tlsVerify: true,
    requestTimeoutMs: 1000,
    screenshotTimeoutMs: 45000,
    maxConcurrency: 4,
    maxLookbackHours: 720,
    maxDataPoints: 2000,
    redactionPatterns: [],
    dataDir,
    webhookPort: 0,
    webhookBindAddress: '127.0.0.1',
    ...overrides,
  };
}

/** Starts the listener on an ephemeral port and resolves once it's actually listening. */
async function listen(cfg: Config): Promise<{ url: string; address: string }> {
  server = startWebhookListener(0, cfg);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const info = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${info.port}`, address: info.address };
}

const ALERT_BODY = JSON.stringify({ alerts: [{ fingerprint: 'abc', labels: { alertname: 'Disk' } }] });

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'webhook-listener-test-'));
  // The listener logs its bind address and any warning on startup; keep the
  // test output clean without losing the ability to assert on the calls.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await rm(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('bind address', () => {
  it('binds loopback by default', async () => {
    const { address } = await listen(config());
    expect(address).toBe('127.0.0.1');
  });

  it('binds wider only when explicitly told to', async () => {
    const { address } = await listen(config({ webhookBindAddress: '0.0.0.0' }));
    expect(address).toBe('0.0.0.0');
  });

  it('warns loudly about a wide bind with no token', async () => {
    await listen(config({ webhookBindAddress: '0.0.0.0' }));
    const logged = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(logged).toContain('WARNING');
    expect(logged).toContain('WEBHOOK_TOKEN');
  });

  it('does not warn about a wide bind that is authenticated', async () => {
    await listen(config({ webhookBindAddress: '0.0.0.0', webhookToken: 's3cret' }));
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain('WARNING');
  });

  it('does not warn on the loopback default', async () => {
    await listen(config());
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain('WARNING');
  });
});

describe('with no token configured', () => {
  it('accepts and stores a well-formed alert', async () => {
    const { url } = await listen(config());
    const res = await fetch(url, { method: 'POST', body: ALERT_BODY });

    expect(res.status).toBe(200);
    const stored = await readFile(join(dataDir, 'alerts.jsonl'), 'utf8');
    expect(stored).toContain('"fingerprint":"abc"');
  });

  it('rejects a body with no alerts array', async () => {
    const { url } = await listen(config());
    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ nope: true }) });
    expect(res.status).toBe(400);
  });

  it('404s any route that is not POST /', async () => {
    const { url } = await listen(config());
    expect((await fetch(`${url}/other`, { method: 'POST', body: ALERT_BODY })).status).toBe(404);
    expect((await fetch(url)).status).toBe(404);
  });
});

describe('with a token configured', () => {
  const cfg = () => config({ webhookToken: 's3cret' });

  it('accepts the correct bearer token', async () => {
    const { url } = await listen(cfg());
    const res = await fetch(url, {
      method: 'POST',
      body: ALERT_BODY,
      headers: { Authorization: 'Bearer s3cret' },
    });

    expect(res.status).toBe(200);
    expect(await readFile(join(dataDir, 'alerts.jsonl'), 'utf8')).toContain('"fingerprint":"abc"');
  });

  it('accepts the scheme case-insensitively, as RFC 7235 requires', async () => {
    const { url } = await listen(cfg());
    const res = await fetch(url, {
      method: 'POST',
      body: ALERT_BODY,
      headers: { Authorization: 'bearer s3cret' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a request with no Authorization header, and stores nothing', async () => {
    const { url } = await listen(cfg());
    const res = await fetch(url, { method: 'POST', body: ALERT_BODY });

    expect(res.status).toBe(401);
    await expect(readFile(join(dataDir, 'alerts.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('rejects a wrong token', async () => {
    const { url } = await listen(cfg());
    const res = await fetch(url, {
      method: 'POST',
      body: ALERT_BODY,
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a token that is a prefix of the real one', async () => {
    const { url } = await listen(cfg());
    const res = await fetch(url, {
      method: 'POST',
      body: ALERT_BODY,
      headers: { Authorization: 'Bearer s3cre' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a non-bearer scheme carrying the right secret', async () => {
    const { url } = await listen(cfg());
    const res = await fetch(url, {
      method: 'POST',
      body: ALERT_BODY,
      headers: { Authorization: 'Basic s3cret' },
    });
    expect(res.status).toBe(401);
  });

  it('answers 401 rather than 404 on an unknown route, so an unauthenticated caller learns nothing', async () => {
    const { url } = await listen(cfg());
    const res = await fetch(`${url}/some/other/path`);

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });
});
