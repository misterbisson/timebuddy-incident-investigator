import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConnectionsFromDisk } from '../src/connections/store.js';
import type { Config } from '../src/config.js';

let dir: string;

function config(): Config {
  return {
    connections: [],
    connectionsDir: dir,
    tlsVerify: true,
    requestTimeoutMs: 1000,
    maxConcurrency: 4,
    maxLookbackHours: 720,
    maxDataPoints: 2000,
    redactionPatterns: [],
    dataDir: '.data',
    webhookPort: 4318,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'connections-store-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadConnectionsFromDisk', () => {
  it('returns [] when no connections.json exists yet', async () => {
    expect(await loadConnectionsFromDisk(config())).toEqual([]);
  });

  it('merges connections.json metadata with credentials.json secrets by id', async () => {
    await writeFile(
      join(dir, 'connections.json'),
      JSON.stringify({
        version: 1,
        connections: [
          { id: 'prod', name: 'prod', url: 'https://grafana.prod.example.com/', authType: 'bearer' },
          { id: 'eu', name: 'eu', url: 'https://grafana.eu.example.com', authType: 'basic', username: 'alice' },
        ],
      }),
    );
    await writeFile(
      join(dir, 'credentials.json'),
      JSON.stringify({
        version: 1,
        credentials: {
          prod: { authType: 'bearer', token: 'tok-123' },
          eu: { authType: 'basic', username: 'alice', password: 'secret' },
        },
      }),
    );

    const connections = await loadConnectionsFromDisk(config());
    expect(connections).toHaveLength(2);

    const prod = connections.find((c) => c.id === 'prod')!;
    expect(prod.url).toBe('https://grafana.prod.example.com');
    expect(prod.token).toBe('tok-123');

    const eu = connections.find((c) => c.id === 'eu')!;
    expect(eu.username).toBe('alice');
    expect(eu.password).toBe('secret');
  });

  it('leaves credentials undefined when credentials.json has no entry for a connection', async () => {
    await writeFile(
      join(dir, 'connections.json'),
      JSON.stringify({ version: 1, connections: [{ id: 'prod', name: 'prod', url: 'https://grafana.prod.example.com', authType: 'bearer' }] }),
    );

    const [connection] = await loadConnectionsFromDisk(config());
    expect(connection!.token).toBeUndefined();
  });
});
