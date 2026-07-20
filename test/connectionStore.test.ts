import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

/**
 * Exercises the real electron/src/connectionStore.js — not just its extracted
 * core — because the write *ordering* and the atomic-write wiring only exist
 * here, and this file is otherwise only reachable via
 * electron/test/mcpServerMode.mjs, which needs the Electron binary that CI
 * (and a plain `npm install` at the root) doesn't have.
 *
 * `electron` is stubbed through Module._load, which is the only interception
 * point that works when the module isn't installed at all: require.cache can't
 * be seeded with a path that doesn't resolve.
 */
const require = createRequire(import.meta.url);
const Module = require('node:module') as { _load: (...args: unknown[]) => unknown };

let dir: string;
let store: {
  listConnectionsForDisplay: () => Array<Record<string, unknown>>;
  upsertConnection: (draft: Record<string, unknown>) => Record<string, unknown>;
  deleteConnection: (id: string) => void;
  getConnectionsForEngine: () => Array<Record<string, unknown>>;
};
let originalLoad: (...args: unknown[]) => unknown;
/** Ciphertexts the fake keychain should refuse, simulating a stale entry. */
let undecryptable: Set<string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'connection-store-test-'));
  undecryptable = new Set();

  const fakeElectron = {
    app: { getPath: (name: string) => (name === 'userData' ? dir : dir) },
    safeStorage: {
      isEncryptionAvailable: () => true,
      // A reversible stand-in for the OS keychain: enough to round-trip, and
      // to fail on demand the way safeStorage does after a keychain reset.
      encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
      decryptString: (buf: Buffer) => {
        const raw = buf.toString('utf8');
        if (undecryptable.has(raw)) {
          throw new Error('Error while decrypting the ciphertext provided to safeStorage');
        }
        return raw.replace(/^enc:/, '');
      },
    },
  };

  originalLoad = Module._load;
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, ...rest);
  } as typeof Module._load;

  delete require.cache[require.resolve('../electron/src/connectionStore.js')];
  delete require.cache[require.resolve('../electron/src/connectionStoreCore.js')];
  store = require('../electron/src/connectionStore.js');
});

afterEach(() => {
  Module._load = originalLoad;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const bearer = (name: string) => ({ name, url: 'https://g.example.com', authType: 'bearer', token: `tok-${name}` });
const readStore = (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
/** The stored ciphertext for a connection, as the fake keychain would see it. */
const cipherFor = (id: string) => Buffer.from(readStore('secrets.enc.json').secrets[id], 'base64').toString('utf8');

describe('connectionStore round trip', () => {
  it('stores a connection and returns it to the engine with its secret', () => {
    const saved = store.upsertConnection(bearer('prod'));
    const engine = store.getConnectionsForEngine();
    expect(engine).toHaveLength(1);
    expect(engine[0]).toMatchObject({ id: saved.id, name: 'prod', token: 'tok-prod' });
  });

  it('strips a trailing slash from the url and reports hasSecret', () => {
    const saved = store.upsertConnection({ ...bearer('prod'), url: 'https://g.example.com///' });
    expect(saved).toMatchObject({ url: 'https://g.example.com', hasSecret: true });
  });

  it('keeps the existing secret when an edit leaves the token blank', () => {
    const saved = store.upsertConnection(bearer('prod'));
    store.upsertConnection({ id: saved.id, name: 'prod renamed', url: 'https://g.example.com', authType: 'bearer', token: '' });
    const engine = store.getConnectionsForEngine();
    expect(engine[0]).toMatchObject({ name: 'prod renamed', token: 'tok-prod' });
  });

  it('removes a connection and its secret on delete', () => {
    const saved = store.upsertConnection(bearer('prod'));
    store.deleteConnection(saved.id as string);
    expect(store.getConnectionsForEngine()).toEqual([]);
    expect(readStore('secrets.enc.json').secrets).toEqual({});
  });
});

describe('one undecryptable secret does not break the other connections', () => {
  it('returns every connection, with only the broken one missing its credential', () => {
    const a = store.upsertConnection(bearer('a'));
    const b = store.upsertConnection(bearer('b'));
    const c = store.upsertConnection(bearer('c'));
    undecryptable.add(cipherFor(b.id as string));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const engine = store.getConnectionsForEngine();
    expect(engine.map((e) => e.id)).toEqual([a.id, b.id, c.id]);
    expect(engine[0].token).toBe('tok-a');
    expect(engine[2].token).toBe('tok-c');
    expect(engine[1].token).toBeUndefined();
  });

  it('logs the cause to stderr, naming the connection', () => {
    const b = store.upsertConnection(bearer('b'));
    undecryptable.add(cipherFor(b.id as string));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    store.getConnectionsForEngine();
    expect(spy).toHaveBeenCalledOnce();
    const message = String(spy.mock.calls[0]![0]);
    expect(message).toContain('"b"');
    expect(message).toContain('re-entered');
    expect(message).toContain('Other connections are unaffected');
  });

  it('distinguishes "cannot decrypt" from "no secret saved" in the UI list', () => {
    const withSecret = store.upsertConnection(bearer('has'));
    store.upsertConnection({ name: 'none', url: 'https://g.example.com', authType: 'bearer', token: '' });
    undecryptable.add(cipherFor(withSecret.id as string));

    const rows = store.listConnectionsForDisplay();
    const broken = rows.find((r) => r.name === 'has')!;
    const never = rows.find((r) => r.name === 'none')!;

    expect(broken.hasSecret).toBe(true);
    expect(broken.secretError).toContain('decrypting');
    expect(never.hasSecret).toBe(false);
    expect(never.secretError).toBeUndefined();
  });
});

describe('store files survive an interrupted write', () => {
  // The old code threw here too — a SyntaxError has no `.code`, so it fell
  // past the ENOENT check. What's new is a message that names the file and
  // says what to do, since this is the error a user hits when the app has
  // stopped working entirely.
  it('reports a truncated connections.json with a repairable error, not a bare SyntaxError', () => {
    store.upsertConnection(bearer('prod'));
    writeFileSync(join(dir, 'connections.json'), '{"version":1,"connections":[{"id"');
    expect(() => store.getConnectionsForEngine()).toThrow(/not valid JSON/);
    expect(() => store.getConnectionsForEngine()).toThrow(/connections\.json/);
  });

  // Passes against the old code too, and is here as a regression guard rather
  // than as evidence of a fix: it pins the choice *not* to adopt the engine
  // caches' swallow-and-rebuild behavior, which would make this upsert
  // overwrite the damaged file with an empty one.
  it('does not overwrite a corrupt connections.json with a fresh empty one', () => {
    store.upsertConnection(bearer('prod'));
    const corrupt = '{"version":1,"connections":[{"id"';
    writeFileSync(join(dir, 'connections.json'), corrupt);
    expect(() => store.upsertConnection(bearer('new'))).toThrow();
    expect(readFileSync(join(dir, 'connections.json'), 'utf8')).toBe(corrupt);
  });

  it('leaves no temp files behind after a normal write', () => {
    store.upsertConnection(bearer('prod'));
    const { readdirSync } = require('node:fs');
    expect(readdirSync(dir).sort()).toEqual(['connections.json', 'secrets.enc.json']);
  });
});

describe('write ordering keeps the two files skewed in the harmless direction', () => {
  // A crash between the two writes must never leave a connection listed
  // whose secret hasn't landed — that's the "exists but won't authenticate"
  // state this change is about eliminating. An orphaned secret is invisible.
  it('writes secrets before connections on upsert', () => {
    const order: string[] = [];
    const fs = require('node:fs');
    const realRename = fs.renameSync;
    fs.renameSync = (from: string, to: string) => {
      order.push(String(to).split('/').pop()!);
      return realRename(from, to);
    };
    try {
      store.upsertConnection(bearer('prod'));
    } finally {
      fs.renameSync = realRename;
    }
    expect(order).toEqual(['secrets.enc.json', 'connections.json']);
  });

  it('writes connections before secrets on delete, for the same reason', () => {
    const saved = store.upsertConnection(bearer('prod'));
    const order: string[] = [];
    const fs = require('node:fs');
    const realRename = fs.renameSync;
    fs.renameSync = (from: string, to: string) => {
      order.push(String(to).split('/').pop()!);
      return realRename(from, to);
    };
    try {
      store.deleteConnection(saved.id as string);
    } finally {
      fs.renameSync = realRename;
    }
    expect(order).toEqual(['connections.json', 'secrets.enc.json']);
  });
});

describe('timestamps', () => {
  // Was `?? new Date(0)`, and the renderer's readDraft never sets updatedAt,
  // so every connection was stamped 1970-01-01 in practice.
  it('stamps createdAt/updatedAt with the current time, not the Unix epoch', () => {
    const before = Date.now();
    store.upsertConnection(bearer('prod'));
    const [meta] = readStore('connections.json').connections;

    expect(meta.createdAt).not.toBe('1970-01-01T00:00:00.000Z');
    expect(Date.parse(meta.createdAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(meta.updatedAt)).toBeGreaterThanOrEqual(before);
  });

  it('preserves createdAt across an edit while moving updatedAt forward', async () => {
    const saved = store.upsertConnection(bearer('prod'));
    const created = readStore('connections.json').connections[0].createdAt;
    await new Promise((r) => setTimeout(r, 5));
    store.upsertConnection({ id: saved.id, name: 'renamed', url: 'https://g.example.com', authType: 'bearer' });

    const [meta] = readStore('connections.json').connections;
    expect(meta.createdAt).toBe(created);
    expect(Date.parse(meta.updatedAt)).toBeGreaterThan(Date.parse(created));
  });
});
