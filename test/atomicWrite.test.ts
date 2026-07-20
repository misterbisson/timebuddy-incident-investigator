import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeJsonFileAtomic } from '../src/util/atomicWrite.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-write-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeJsonFileAtomic', () => {
  it('writes pretty-printed JSON that round-trips', async () => {
    const target = join(dir, 'out.json');
    await writeJsonFileAtomic(target, { a: 1, b: [2, 3] });

    const text = await readFile(target, 'utf8');
    expect(JSON.parse(text)).toEqual({ a: 1, b: [2, 3] });
    expect(text).toContain('\n'); // pretty-printed, not a single line
  });

  it('creates the parent directory if it does not exist', async () => {
    const target = join(dir, 'nested', 'deeper', 'out.json');
    await writeJsonFileAtomic(target, { ok: true });
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ ok: true });
  });

  it('replaces an existing file wholesale', async () => {
    const target = join(dir, 'out.json');
    await writeFile(target, JSON.stringify({ old: true }), 'utf8');
    await writeJsonFileAtomic(target, { new: true });
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ new: true });
  });

  it('leaves no temp file behind on success', async () => {
    await writeJsonFileAtomic(join(dir, 'out.json'), { ok: true });
    const entries = await readdir(dir);
    expect(entries).toEqual(['out.json']);
  });

  it('never exposes a partially written target (the reader sees old or new, never torn)', async () => {
    const target = join(dir, 'out.json');
    // Seed a valid file, then fire many overlapping writes of large distinct
    // payloads while continuously reading. Every read must parse — a plain
    // writeFile would let a reader observe a half-flushed file here.
    await writeJsonFileAtomic(target, { seed: true });

    const writers = Array.from({ length: 25 }, (_, i) =>
      writeJsonFileAtomic(target, { n: i, blob: 'x'.repeat(200_000) }),
    );

    let reads = 0;
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        // A torn write surfaces as a JSON.parse throw here.
        JSON.parse(await readFile(target, 'utf8'));
        reads++;
      }
    })();

    await Promise.all(writers);
    stop = true;
    await reader;

    expect(reads).toBeGreaterThan(0);
    // The final state is one of the payloads, intact.
    const final = JSON.parse(await readFile(target, 'utf8'));
    expect(final).toHaveProperty('n');
  });
});
