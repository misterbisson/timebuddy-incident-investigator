import { describe, expect, it } from 'vitest';
import { ConnectionRegistry } from '../src/grafana/registry.js';
import type { GrafanaConnection } from '../src/config.js';
import type { Config } from '../src/config.js';

const config: Config = {
  connections: [],
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

const conn = (overrides: Partial<GrafanaConnection>): GrafanaConnection => ({
  id: 'a',
  name: 'a',
  url: 'https://grafana.example.com',
  authType: 'bearer',
  token: 'x',
  ...overrides,
});

describe('ConnectionRegistry', () => {
  it('list() returns the same static array reference every call, when given a plain array', async () => {
    const connections = [conn({})];
    const registry = new ConnectionRegistry(connections, config);
    expect(await registry.list()).toBe(connections);
    expect(await registry.list()).toBe(connections);
  });

  it('list() re-invokes a thunk source on every call, reflecting connections added after construction', async () => {
    let connections = [conn({ id: 'a' })];
    const registry = new ConnectionRegistry(() => connections, config);
    expect((await registry.list()).map((c) => c.id)).toEqual(['a']);

    connections = [...connections, conn({ id: 'b' })];
    expect((await registry.list()).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('accepts a thunk that returns a Promise, as the Electron store does now that safeStorage decrypts asynchronously', async () => {
    let connections = [conn({ id: 'a' })];
    const registry = new ConnectionRegistry(async () => connections, config);
    expect((await registry.list()).map((c) => c.id)).toEqual(['a']);
    await expect(registry.get('a')).resolves.toBeDefined();

    connections = [conn({ id: 'b' })];
    await expect(registry.get('a')).rejects.toThrow(/Unknown Grafana connection/);
    await expect(registry.get('b')).resolves.toBeDefined();
  });

  it('lastListed() is the plain array for a static source, and empty for a thunk until the first list()', async () => {
    const fixed = [conn({ id: 'a' })];
    expect(new ConnectionRegistry(fixed, config).lastListed()).toBe(fixed);

    let connections = [conn({ id: 'a' })];
    const registry = new ConnectionRegistry(async () => connections, config);
    expect(registry.lastListed()).toEqual([]);

    await registry.list();
    expect(registry.lastListed().map((c) => c.id)).toEqual(['a']);

    // It never re-reads the source on its own: that is list()'s job.
    connections = [conn({ id: 'b' })];
    expect(registry.lastListed().map((c) => c.id)).toEqual(['a']);
    await registry.get('b');
    expect(registry.lastListed().map((c) => c.id)).toEqual(['b']);
  });

  it('get() picks up a connection added after the registry was constructed, with no restart', async () => {
    let connections: GrafanaConnection[] = [];
    const registry = new ConnectionRegistry(() => connections, config);
    await expect(registry.get('a')).rejects.toThrow(/Unknown Grafana connection/);

    connections = [conn({ id: 'a' })];
    await expect(registry.get('a')).resolves.toBeDefined();
  });

  it('get() returns the same cached client when the connection config is unchanged', async () => {
    const connections = [conn({ id: 'a' })];
    const registry = new ConnectionRegistry(() => connections, config);
    expect(await registry.get('a')).toBe(await registry.get('a'));
  });

  it('concurrent get() calls for an already-cached connection all return that one client', async () => {
    const connections = [conn({ id: 'a' })];
    const registry = new ConnectionRegistry(async () => connections, config);
    const first = await registry.get('a');
    const all = await Promise.all([registry.get('a'), registry.get('a'), registry.get('a')]);
    for (const client of all) expect(client).toBe(first);
  });

  it('get() rebuilds the client when the connection config changes (e.g. a rotated token)', async () => {
    let connections = [conn({ id: 'a', token: 'old-token' })];
    const registry = new ConnectionRegistry(() => connections, config);
    const first = await registry.get('a');

    connections = [conn({ id: 'a', token: 'new-token' })];
    const second = await registry.get('a');
    expect(second).not.toBe(first);
  });

  it('get() throws for an id no longer present in the current list', async () => {
    let connections = [conn({ id: 'a' })];
    const registry = new ConnectionRegistry(() => connections, config);
    await registry.get('a');

    connections = [];
    await expect(registry.get('a')).rejects.toThrow(/Unknown Grafana connection/);
  });
});
