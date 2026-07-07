import { describe, expect, it } from 'vitest';
import { ConnectionRegistry } from '../src/grafana/registry.js';
import type { GrafanaConnection } from '../src/config.js';
import type { Config } from '../src/config.js';

const config: Config = {
  connections: [],
  tlsVerify: true,
  requestTimeoutMs: 1000,
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
  it('list() returns the same static array reference every call, when given a plain array', () => {
    const connections = [conn({})];
    const registry = new ConnectionRegistry(connections, config);
    expect(registry.list()).toBe(connections);
    expect(registry.list()).toBe(connections);
  });

  it('list() re-invokes a thunk source on every call, reflecting connections added after construction', () => {
    let connections = [conn({ id: 'a' })];
    const registry = new ConnectionRegistry(() => connections, config);
    expect(registry.list().map((c) => c.id)).toEqual(['a']);

    connections = [...connections, conn({ id: 'b' })];
    expect(registry.list().map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('get() picks up a connection added after the registry was constructed, with no restart', () => {
    let connections: GrafanaConnection[] = [];
    const registry = new ConnectionRegistry(() => connections, config);
    expect(() => registry.get('a')).toThrow(/Unknown Grafana connection/);

    connections = [conn({ id: 'a' })];
    expect(() => registry.get('a')).not.toThrow();
  });

  it('get() returns the same cached client when the connection config is unchanged', () => {
    const connections = [conn({ id: 'a' })];
    const registry = new ConnectionRegistry(() => connections, config);
    expect(registry.get('a')).toBe(registry.get('a'));
  });

  it('get() rebuilds the client when the connection config changes (e.g. a rotated token)', () => {
    let connections = [conn({ id: 'a', token: 'old-token' })];
    const registry = new ConnectionRegistry(() => connections, config);
    const first = registry.get('a');

    connections = [conn({ id: 'a', token: 'new-token' })];
    const second = registry.get('a');
    expect(second).not.toBe(first);
  });

  it('get() throws for an id no longer present in the current list', () => {
    let connections = [conn({ id: 'a' })];
    const registry = new ConnectionRegistry(() => connections, config);
    registry.get('a');

    connections = [];
    expect(() => registry.get('a')).toThrow(/Unknown Grafana connection/);
  });
});
