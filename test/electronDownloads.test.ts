import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The two Downloads FS controls behind the Activity window's Export/Capture
// buttons live in the Electron workspace as plain CommonJS (no Electron
// imports, precisely so they can be exercised here). Require them directly —
// main.js just binds writeToDir to app.getPath('downloads') and the reveal
// handler to isWithinDirectory. These are the security controls a renderer
// (Grafana-derived) input reaches, so they get pinned coverage the
// spawned-binary smoke test can't give.
const require = createRequire(import.meta.url);
const { writeToDir, isWithinDirectory } = require('../electron/src/downloads.js') as {
  writeToDir: (dir: string, filename: string, data: string | Buffer) => Promise<string>;
  isWithinDirectory: (dir: string, candidate: string) => boolean;
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'downloads-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeToDir', () => {
  it('strips any path components from the suggested name so the write stays inside dir', async () => {
    // A traversal-shaped name must land as a plain basename inside dir, never
    // escape it. (If path.basename were dropped, this would try to write to
    // the parent of dir.)
    const full = await writeToDir(dir, '../../etc/passwd', 'x');
    expect(full).toBe(join(dir, 'passwd'));
    expect(await readdir(dir)).toEqual(['passwd']);
  });

  it('reduces an absolute path to its basename inside dir', async () => {
    const full = await writeToDir(dir, '/etc/hosts', 'x');
    expect(full).toBe(join(dir, 'hosts'));
  });

  it('never clobbers an existing file — it appends " (n)" until a name is free', async () => {
    await writeFile(join(dir, 'panel5.csv'), 'original');
    const full = await writeToDir(dir, 'panel5.csv', 'fresh');
    expect(full).toBe(join(dir, 'panel5 (2).csv'));
    // The pre-existing file is untouched; the new content went to the (2) name.
    expect(await readFile(join(dir, 'panel5.csv'), 'utf8')).toBe('original');
    expect(await readFile(join(dir, 'panel5 (2).csv'), 'utf8')).toBe('fresh');
  });

  it('keeps counting past the first collision', async () => {
    await writeFile(join(dir, 'a.png'), '1');
    await writeFile(join(dir, 'a (2).png'), '2');
    const full = await writeToDir(dir, 'a.png', '3');
    expect(full).toBe(join(dir, 'a (3).png'));
  });
});

describe('isWithinDirectory', () => {
  it('accepts the directory itself and paths strictly inside it', () => {
    expect(isWithinDirectory(dir, dir)).toBe(true);
    expect(isWithinDirectory(dir, join(dir, 'panel5.csv'))).toBe(true);
    expect(isWithinDirectory(dir, join(dir, 'nested', 'x.png'))).toBe(true);
  });

  it('rejects a sibling whose name merely shares the prefix', () => {
    // The load-bearing case: a bare startsWith(dir) would accept this, letting
    // a reveal escape the intended Downloads scope.
    expect(isWithinDirectory(dir, `${dir}-evil${sep}secret`)).toBe(false);
    expect(isWithinDirectory(dir, `${dir}-evil`)).toBe(false);
  });

  it('rejects a path that traverses back out of the directory', () => {
    expect(isWithinDirectory(dir, join(dir, '..', 'elsewhere'))).toBe(false);
  });
});
