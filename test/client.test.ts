import { describe, expect, it } from 'vitest';
import { buildAuthHeader } from '../src/grafana/client.js';
import type { GrafanaConnection } from '../src/config.js';

function connection(overrides: Partial<GrafanaConnection>): GrafanaConnection {
  return { id: 'test', name: 'test', url: 'https://grafana.example.com', authType: 'bearer', ...overrides };
}

describe('buildAuthHeader', () => {
  it('builds a Bearer header for a bearer connection', () => {
    expect(buildAuthHeader(connection({ authType: 'bearer', token: 'glsa_abc123' }))).toBe('Bearer glsa_abc123');
  });

  it('builds a base64-encoded Basic header for a basic connection', () => {
    const header = buildAuthHeader(connection({ authType: 'basic', username: 'alice', password: 'hunter2' }));
    expect(header).toBe(`Basic ${Buffer.from('alice:hunter2').toString('base64')}`);
  });

  it('throws when a bearer connection has no token', () => {
    expect(() => buildAuthHeader(connection({ authType: 'bearer' }))).toThrow(/missing token/);
  });

  it('throws when a basic connection is missing username or password', () => {
    expect(() => buildAuthHeader(connection({ authType: 'basic', username: 'alice' }))).toThrow(/missing username\/password/);
  });
});
