import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

/**
 * Writes a file such that a concurrent reader never observes a torn or
 * partial result: content goes to a temp file in the same directory, which
 * is then atomically renamed over the target (rename replaces the target's
 * directory entry as a single operation on every platform we run on).
 *
 * This matters here because the on-disk caches it backs (the metric index,
 * the knowledge cache) are read with a plain "read + JSON.parse, treat any
 * failure as a cache miss and rebuild" path. A half-written file from an
 * overlapping save would parse as garbage, silently discard the cache, and
 * trigger another multi-minute crawl — so the write being atomic is what
 * keeps that failure mode from existing at all.
 *
 * Durability across power loss is deliberately NOT a goal: every caller here
 * writes a cache that is rebuilt from Grafana on the next miss, so paying for
 * fsync on every save would buy nothing. (The connection store, which holds
 * unrecoverable secrets, has its own fsync-backed writer in the electron
 * workspace.) The temp name carries the pid *and* a per-call counter: the pid
 * keeps two processes apart, and the counter keeps two overlapping calls in
 * the SAME process from sharing one temp file (which would let one call's
 * rename fire while the other was still writing that temp — a torn target, or
 * an ENOENT when the second went to rename a temp the first had already moved).
 * The final rename is last-writer-wins, which is correct for a cache.
 */
let tmpCounter = 0;

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}.${tmpCounter++}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, filePath);
  } catch (err) {
    // Don't leave a stray temp file behind on a failed write.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
