import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Plain CommonJS with no `electron` import of its own (safeStorage's decrypt is
// a parameter, paths are arguments), so it's unit-testable here without the
// Electron binary — which CI doesn't install.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CorruptStoreError, readJsonFile, writeJsonFileAtomic, buildEngineConnections } = require('../electron/src/connectionStoreCore.js');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'connection-store-core-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('buildEngineConnections', () => {
  const meta = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `conn-${id}`,
    url: `https://${id}.example.com`,
    authType: 'bearer',
    ...extra,
  });
  const ok = () => ({ authType: 'bearer', token: 'secret-token' });

  it('decrypts each connection and maps it to the engine shape', () => {
    const { connections, failures } = buildEngineConnections([meta('a')], { a: 'enc-a' }, ok);
    expect(failures).toEqual([]);
    expect(connections[0]).toMatchObject({ id: 'a', url: 'https://a.example.com', token: 'secret-token' });
  });

  // The reported bug: getConnectionsForEngine is the ConnectionsSource thunk,
  // re-invoked on every tool call, so one throw here failed every tool call —
  // including ones that never touch the broken connection.
  it('isolates a failing decrypt so the other connections still resolve', () => {
    const decrypt = vi.fn((encoded: string) => {
      if (encoded === 'enc-b') throw new Error('Error while decrypting the ciphertext provided to safeStorage');
      return ok();
    });
    const { connections, failures } = buildEngineConnections(
      [meta('a'), meta('b'), meta('c')],
      { a: 'enc-a', b: 'enc-b', c: 'enc-c' },
      decrypt,
    );

    expect(connections).toHaveLength(3);
    expect(connections[0].token).toBe('secret-token');
    expect(connections[2].token).toBe('secret-token');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ id: 'b', name: 'conn-b' });
    expect(failures[0].reason).toContain('decrypting');
  });

  // Kept in the list rather than dropped, so buildAuthHeader raises
  // `Connection "b" is authType=bearer but missing token` at the point of use
  // and resolveConnection's "available connections" list stays honest.
  it('keeps the broken connection listed, but without a credential', () => {
    const decrypt = () => {
      throw new Error('keychain mismatch');
    };
    const { connections } = buildEngineConnections([meta('b')], { b: 'enc-b' }, decrypt);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ id: 'b', authType: 'bearer' });
    expect(connections[0].token).toBeUndefined();
  });

  it('reports every failure, not just the first', () => {
    const decrypt = () => {
      throw new Error('nope');
    };
    const { failures } = buildEngineConnections([meta('a'), meta('b')], { a: 'x', b: 'y' }, decrypt);
    expect(failures.map((f: { id: string }) => f.id)).toEqual(['a', 'b']);
  });

  it('does not call decrypt at all for a connection with no stored secret', () => {
    const decrypt = vi.fn(ok);
    const { connections, failures } = buildEngineConnections([meta('a', { username: 'u' })], {}, decrypt);
    expect(decrypt).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
    expect(connections[0].username).toBe('u');
  });

  it('maps a basic-auth secret to username/password', () => {
    const decrypt = () => ({ authType: 'basic', username: 'u', password: 'p' });
    const { connections } = buildEngineConnections([meta('a', { authType: 'basic' })], { a: 'enc' }, decrypt);
    expect(connections[0]).toMatchObject({ username: 'u', password: 'p' });
    expect(connections[0].token).toBeUndefined();
  });
});

describe('readJsonFile', () => {
  it('returns the fallback when the file does not exist (first run)', () => {
    expect(readJsonFile(join(dir, 'nope.json'), { version: 1, connections: [] })).toEqual({ version: 1, connections: [] });
  });

  it('parses an existing file', async () => {
    await writeFile(join(dir, 'c.json'), JSON.stringify({ version: 1, connections: [{ id: 'a' }] }));
    expect(readJsonFile(join(dir, 'c.json'), null)).toEqual({ version: 1, connections: [{ id: 'a' }] });
  });

  // Deliberately unlike the engine's caches, which swallow parse errors and
  // rebuild. Falling back to "no connections" here would let the next
  // upsertConnection write that empty state back, turning a recoverable
  // truncation into permanent loss of every other connection.
  it('throws on a truncated file rather than silently reporting an empty store', async () => {
    const path = join(dir, 'c.json');
    await writeFile(path, '{"version":1,"connections":[{"id":"a"');
    expect(() => readJsonFile(path, { version: 1, connections: [] })).toThrow(CorruptStoreError);
    expect(() => readJsonFile(path, { version: 1, connections: [] })).toThrow(/not valid JSON/);
  });

  it('leaves the damaged file on disk for repair', async () => {
    const path = join(dir, 'c.json');
    await writeFile(path, '{"truncated"');
    expect(() => readJsonFile(path, {})).toThrow();
    expect(await readFile(path, 'utf8')).toBe('{"truncated"');
  });
});

describe('writeJsonFileAtomic', () => {
  it('writes the file and reads back identically', () => {
    const path = join(dir, 'out.json');
    writeJsonFileAtomic(path, { version: 1, connections: [{ id: 'a' }] });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, connections: [{ id: 'a' }] });
  });

  it('creates the directory if it is missing', () => {
    const path = join(dir, 'nested', 'deep', 'out.json');
    writeJsonFileAtomic(path, { ok: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ok: true });
  });

  it('leaves no temp file behind on success', () => {
    writeJsonFileAtomic(join(dir, 'out.json'), { ok: true });
    expect(readdirSync(dir)).toEqual(['out.json']);
  });

  // The property that makes this atomic: a reader concurrent with a write
  // sees the whole old file or the whole new one, never a truncated prefix.
  it('never exposes a partial file: the previous content stays readable until the swap', () => {
    const path = join(dir, 'out.json');
    writeJsonFileAtomic(path, { generation: 1 });

    const seen: unknown[] = [];
    // Observe the directory mid-write by hooking rename, the moment the swap
    // becomes visible. Before it, the old file must still parse cleanly.
    const fs = require('node:fs');
    const realRename = fs.renameSync;
    fs.renameSync = (from: string, to: string) => {
      seen.push(JSON.parse(readFileSync(path, 'utf8')));
      return realRename(from, to);
    };
    try {
      writeJsonFileAtomic(path, { generation: 2 });
    } finally {
      fs.renameSync = realRename;
    }

    expect(seen).toEqual([{ generation: 1 }]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ generation: 2 });
  });

  it('overwrites an existing file rather than appending to it', () => {
    const path = join(dir, 'out.json');
    writeJsonFileAtomic(path, { a: 1, b: 2, c: 3 });
    writeJsonFileAtomic(path, { a: 1 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
  });
});
