import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chmodSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Plain CommonJS with no `electron` import of its own (safeStorage's decrypt is
// a parameter, paths are arguments), so it's unit-testable here without the
// Electron binary — which CI doesn't install.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CorruptStoreError,
  SecretFormatError,
  ImportValidationError,
  STORE_FILE_MODE,
  describeSecretFailure,
  readJsonFile,
  writeJsonFileAtomic,
  buildEngineConnections,
  normalizeUrlForKey,
  validateImportManifest,
  planImport,
} = require('../electron/src/connectionStoreCore.js');

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
    // The reason is describeSecretFailure's fixed text, never the thrown
    // error's own message — this assertion originally checked the raw message,
    // which is exactly the string that could carry credential material.
    expect(failures[0].reason).toContain('keychain could not decrypt');
    expect(failures[0].reason).not.toContain('safeStorage');
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

describe('writeJsonFileAtomic file permissions', () => {
  const modeOf = (p: string) => (statSync(p).mode & 0o777).toString(8);
  const skipOnWindows = process.platform === 'win32';

  // A regression this fix introduced and had to take back out: rename replaces
  // the target inode, so the *temp* file's mode is what survives. A plain
  // openSync(tmp, 'w') creates 0644 under a default umask, so every write
  // silently widened a credential file that main's writeFileSync had left at
  // 0600 (O_TRUNC on an existing file doesn't touch its mode).
  it.skipIf(skipOnWindows)('writes a new file owner-only, not umask-default 0644', () => {
    const path = join(dir, 'secrets.enc.json');
    writeJsonFileAtomic(path, { secrets: {} });
    expect(modeOf(path)).toBe('600');
  });

  it.skipIf(skipOnWindows)('does not widen an existing 0600 file', () => {
    const path = join(dir, 'secrets.enc.json');
    writeJsonFileAtomic(path, { generation: 1 });
    chmodSync(path, 0o600);
    writeJsonFileAtomic(path, { generation: 2 });
    expect(modeOf(path)).toBe('600');
  });

  // The explicit fchmod is what makes this umask-proof: open's mode argument
  // is itself masked, so a umask of 0077 would be fine but 0022 would not.
  it.skipIf(skipOnWindows)('stays owner-only under a permissive umask', () => {
    const previous = process.umask(0o000);
    try {
      const path = join(dir, 'secrets.enc.json');
      writeJsonFileAtomic(path, { secrets: {} });
      expect(modeOf(path)).toBe('600');
    } finally {
      process.umask(previous);
    }
  });

  it('exposes the mode it enforces, so this is pinned to a literal', () => {
    expect(STORE_FILE_MODE).toBe(0o600);
  });
});

describe('writeJsonFileAtomic durability and cleanup', () => {
  const fs = require('node:fs');

  // Previously untested: deleting the fsync call entirely left all 405 tests
  // passing, so half of what this helper exists for had no coverage at all.
  it('fsyncs the file before renaming it, not after', () => {
    const order: string[] = [];
    const realFsync = fs.fsyncSync;
    const realRename = fs.renameSync;
    fs.fsyncSync = (fd: number) => {
      order.push('fsync');
      return realFsync(fd);
    };
    fs.renameSync = (from: string, to: string) => {
      order.push('rename');
      return realRename(from, to);
    };
    try {
      writeJsonFileAtomic(join(dir, 'out.json'), { ok: true });
    } finally {
      fs.fsyncSync = realFsync;
      fs.renameSync = realRename;
    }
    expect(order[0]).toBe('fsync');
    expect(order).toContain('rename');
    expect(order.indexOf('fsync')).toBeLessThan(order.indexOf('rename'));
  });

  // The temp file holds a complete-or-partial encrypted secrets blob, so a
  // failure anywhere in the sequence must not strand one — the old cleanup
  // only covered a failed rename.
  it('removes the temp file when the write itself fails, not just the rename', () => {
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = () => {
      const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      throw err;
    };
    try {
      expect(() => writeJsonFileAtomic(join(dir, 'out.json'), { ok: true })).toThrow(/ENOSPC/);
    } finally {
      fs.writeFileSync = realWrite;
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes the temp file when the rename fails', () => {
    const realRename = fs.renameSync;
    fs.renameSync = () => {
      throw new Error('EPERM: operation not permitted');
    };
    try {
      expect(() => writeJsonFileAtomic(join(dir, 'out.json'), { ok: true })).toThrow(/EPERM/);
    } finally {
      fs.renameSync = realRename;
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('describeSecretFailure', () => {
  // The reported leak: decryptSecret is a decrypt followed by a JSON.parse,
  // and V8 quotes a prefix of the parse input in its message —
  //   Unexpected token 'g', "glsa_SUPER"... is not valid JSON
  // — which reached console.error and the GUI tooltip. So a *successful*
  // decrypt with an unexpected payload published live credential material.
  it('never repeats the underlying error message, which can quote the plaintext', () => {
    let parseError: unknown;
    try {
      JSON.parse('glsa_SUPERSECRETTOKEN_abcdef');
    } catch (err) {
      parseError = err;
    }
    // Confirm the hazard is real before asserting we avoid it.
    expect((parseError as Error).message).toContain('glsa_SUPER');

    const described = describeSecretFailure(new SecretFormatError('stored credential is not in the expected format'));
    expect(described).not.toContain('glsa');
    expect(described).not.toContain('SUPER');
    expect(described).toContain('not in the expected format');
  });

  it('distinguishes a keychain failure from a payload-format failure', () => {
    // Only the keychain case is fixed by re-entering the credential, which is
    // what the GUI status and README both tell the user to do.
    expect(describeSecretFailure(new Error('safeStorage said no'))).toContain('keychain');
    expect(describeSecretFailure(new SecretFormatError('x'))).not.toContain('keychain');
  });
});

describe('normalizeUrlForKey', () => {
  // Must match upsertConnection's own `.replace(/\/+$/, '')`, or a trailing
  // slash in the manifest and none on disk would key as two connections.
  it('strips trailing slashes and surrounding whitespace', () => {
    expect(normalizeUrlForKey('https://g.example.com/')).toBe('https://g.example.com');
    expect(normalizeUrlForKey('https://g.example.com///')).toBe('https://g.example.com');
    expect(normalizeUrlForKey('  https://g.example.com  ')).toBe('https://g.example.com');
  });

  // Deliberately not canonicalized further — matching is against the exact
  // stored string, so "already exists" stays predictable.
  it('does not lowercase the host', () => {
    expect(normalizeUrlForKey('https://G.Example.com')).toBe('https://G.Example.com');
  });
});

describe('validateImportManifest', () => {
  const grafana = (extra: Record<string, unknown> = {}) => ({
    kind: 'grafana',
    name: 'prod',
    url: 'https://g.example.com',
    authType: 'bearer',
    ...extra,
  });

  it('accepts a well-formed manifest and normalizes each entry', () => {
    const { connections } = validateImportManifest({
      version: 1,
      connections: [
        grafana({ tags: [' prod ', 'us', ''], matchHosts: ['lb.internal'] }),
        { kind: 'graylog', name: 'logs', url: 'https://gl.example.com', authType: 'token', streamName: 'APIGW' },
      ],
    });
    expect(connections).toHaveLength(2);
    expect(connections[0]).toMatchObject({
      kind: 'grafana',
      name: 'prod',
      url: 'https://g.example.com',
      authType: 'bearer',
      tlsVerify: true, // defaulted when absent
      tags: ['prod', 'us'], // trimmed, empties dropped
      matchHosts: ['lb.internal'],
    });
    expect(connections[1]).toMatchObject({ kind: 'graylog', authType: 'token', streamName: 'APIGW' });
  });

  it('accepts a bare array as well as a { connections } object', () => {
    const { connections } = validateImportManifest([grafana()]);
    expect(connections).toHaveLength(1);
  });

  it('preserves an explicit tlsVerify: false rather than defaulting it to true', () => {
    const { connections } = validateImportManifest([grafana({ tlsVerify: false })]);
    expect(connections[0].tlsVerify).toBe(false);
  });

  // The load-bearing guardrail: the manifest is meant to live in a repo, so an
  // inline credential is a hard error, not something silently stored.
  it('rejects inline secrets (token/password)', () => {
    expect(() => validateImportManifest([grafana({ token: 'glsa_leaked' })])).toThrow(ImportValidationError);
    expect(() => validateImportManifest([grafana({ token: 'glsa_leaked' })])).toThrow(/must not contain secrets/);
    expect(() => validateImportManifest([grafana({ password: 'hunter2' })])).toThrow(/password/);
  });

  it('rejects a duplicate url+kind within the file (the idempotency key)', () => {
    expect(() =>
      validateImportManifest([grafana({ name: 'a' }), grafana({ name: 'b', url: 'https://g.example.com/' })]),
    ).toThrow(/duplicate url\+kind/);
  });

  // Same url, different kind is NOT a duplicate — a Grafana and a Graylog can
  // legitimately share a hostname.
  it('allows the same url across different kinds', () => {
    const { connections } = validateImportManifest([
      { kind: 'grafana', name: 'g', url: 'https://same.example.com', authType: 'bearer' },
      { kind: 'graylog', name: 'l', url: 'https://same.example.com', authType: 'token' },
    ]);
    expect(connections).toHaveLength(2);
  });

  it('rejects an authType that is wrong for the kind', () => {
    // 'token' is a Graylog authType, not a Grafana one.
    expect(() => validateImportManifest([grafana({ authType: 'token' })])).toThrow(/authType/);
    // 'bearer' is a Grafana authType, not a Graylog one.
    expect(() =>
      validateImportManifest([{ kind: 'graylog', name: 'l', url: 'https://gl.example.com', authType: 'bearer' }]),
    ).toThrow(/authType/);
  });

  it('collects every problem, not just the first', () => {
    let caught: any;
    try {
      validateImportManifest([{ kind: 'nope' }, { kind: 'grafana' }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ImportValidationError);
    // one bad kind + (missing name, url, authType) on the second = 4 problems
    expect(caught.problems.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a manifest with no connections', () => {
    expect(() => validateImportManifest({ version: 1, connections: [] })).toThrow(/no connections/);
  });

  it('rejects an unsupported version', () => {
    expect(() => validateImportManifest({ version: 2, connections: [grafana()] })).toThrow(/version/);
  });

  it('rejects a non-array connections field', () => {
    expect(() => validateImportManifest({ version: 1, connections: 'nope' })).toThrow(/connections/);
  });
});

describe('planImport', () => {
  const entry = (kind: string, url: string, name = 'x') => ({ kind, name, url, authType: 'bearer' });

  it('marks an entry create when nothing matches its url+kind', () => {
    const { plan } = planImport([entry('grafana', 'https://new.example.com')], []);
    expect(plan[0]).toMatchObject({ action: 'create', existingId: undefined });
  });

  it('marks an entry update and carries the existing id when url+kind matches', () => {
    const existing = [{ id: 'conn-1', kind: 'grafana', url: 'https://g.example.com' }];
    const { plan } = planImport([entry('grafana', 'https://g.example.com/')], existing);
    expect(plan[0]).toMatchObject({ action: 'update', existingId: 'conn-1' });
  });

  it('treats a connection with no kind as grafana (pre-kind connections)', () => {
    const existing = [{ id: 'old', url: 'https://g.example.com' }]; // no kind field
    const { plan } = planImport([entry('grafana', 'https://g.example.com')], existing);
    expect(plan[0]).toMatchObject({ action: 'update', existingId: 'old' });
  });

  it('does not match across kinds on the same url', () => {
    const existing = [{ id: 'graylog-1', kind: 'graylog', url: 'https://same.example.com' }];
    const { plan } = planImport([entry('grafana', 'https://same.example.com')], existing);
    expect(plan[0]).toMatchObject({ action: 'create' });
  });
});
