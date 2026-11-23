import { describe, expect, it } from 'vitest';
import { LogConnectionRegistry } from '../src/graylog/registry.js';
import type { Config, LogConnection } from '../src/config.js';

const config: Config = {
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

const conn = (overrides: Partial<LogConnection>): LogConnection => ({
  id: 'a',
  name: 'a',
  sourceType: 'graylog',
  url: 'https://graylog.example.com',
  authType: 'token',
  token: 'x',
  ...overrides,
});

describe('LogConnectionRegistry', () => {
  it('list() returns the same static array reference every call, when given a plain array', async () => {
    const connections = [conn({})];
    const registry = new LogConnectionRegistry(connections, config);
    expect(await registry.list()).toBe(connections);
    expect(await registry.list()).toBe(connections);
  });

  it('list() re-invokes a thunk source on every call, reflecting connections added after construction', async () => {
    let connections = [conn({ id: 'a' })];
    const registry = new LogConnectionRegistry(() => connections, config);
    expect((await registry.list()).map((c) => c.id)).toEqual(['a']);

    connections = [...connections, conn({ id: 'b' })];
    expect((await registry.list()).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('accepts a thunk that returns a Promise, as the Electron store does now that safeStorage decrypts asynchronously', async () => {
    let connections = [conn({ id: 'a' })];
    const registry = new LogConnectionRegistry(async () => connections, config);
    expect((await registry.list()).map((c) => c.id)).toEqual(['a']);
    await expect(registry.get('a')).resolves.toBeDefined();

    connections = [conn({ id: 'b' })];
    await expect(registry.get('a')).rejects.toThrow(/Unknown log connection/);
    await expect(registry.get('b')).resolves.toBeDefined();
  });

  it('resolve() pairs each client with the connection it was built from, even when reads finish out of order', async () => {
    // The review's case: call A reads the store before a GUI edit and call B
    // after it, and B's read finishes first. Each must get back the connection
    // its own read saw, since that's what its links and Activity entry show.
    const pending: Array<(list: ReturnType<typeof conn>[]) => void> = [];
    const registry = new LogConnectionRegistry(() => new Promise((resolve) => pending.push(resolve)), config);

    const callA = registry.resolve('a');
    const callB = registry.resolve('a');
    pending[1]!([conn({ id: 'a', url: 'https://new.example.com' })]);
    const b = await callB;
    pending[0]!([conn({ id: 'a', url: 'https://old.example.com' })]);
    const a = await callA;

    expect(b.connection.url).toBe('https://new.example.com');
    expect(a.connection.url).toBe('https://old.example.com');
    expect(a.client).not.toBe(b.client);
    // And a later call sees the store as it is now, not as the slowest read left it.
    const later = registry.resolve('a');
    pending[2]!([conn({ id: 'a', url: 'https://new.example.com' })]);
    expect((await later).connection.url).toBe('https://new.example.com');
  });

  it('get() picks up a connection added after the registry was constructed, with no restart', async () => {
    let connections: LogConnection[] = [];
    const registry = new LogConnectionRegistry(() => connections, config);
    await expect(registry.get('a')).rejects.toThrow(/Unknown log connection/);

    connections = [conn({ id: 'a' })];
    await expect(registry.get('a')).resolves.toBeDefined();
  });

  it('get() returns the same cached client when the connection config is unchanged', async () => {
    const connections = [conn({ id: 'a' })];
    const registry = new LogConnectionRegistry(() => connections, config);
    expect(await registry.get('a')).toBe(await registry.get('a'));
  });

  it('concurrent get() calls for an already-cached connection all return that one client', async () => {
    const connections = [conn({ id: 'a' })];
    const registry = new LogConnectionRegistry(async () => connections, config);
    const first = await registry.get('a');
    const all = await Promise.all([registry.get('a'), registry.get('a'), registry.get('a')]);
    for (const client of all) expect(client).toBe(first);
  });

  it('get() rebuilds the client when the connection config changes (e.g. a rotated token)', async () => {
    let connections = [conn({ id: 'a', token: 'old-token' })];
    const registry = new LogConnectionRegistry(() => connections, config);
    const first = await registry.get('a');

    connections = [conn({ id: 'a', token: 'new-token' })];
    const second = await registry.get('a');
    expect(second).not.toBe(first);
  });

  it('get() throws for an id no longer present in the current list', async () => {
    let connections = [conn({ id: 'a' })];
    const registry = new LogConnectionRegistry(() => connections, config);
    await registry.get('a');

    connections = [];
    await expect(registry.get('a')).rejects.toThrow(/Unknown log connection/);
  });
});
