import { readdir, stat, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';

/**
 * Best-effort startup housekeeping for the local data dir. Two paths grow
 * without bound on `main` today, and each gets the policy its contents earn:
 *
 *  - `screenshots/` is bounded by AGE. Every `screenshot_panel` call writes a
 *    full-resolution PNG named with `Date.now()`, so nothing is ever
 *    overwritten — by far the highest-volume path, and worthless once the
 *    incident it captured is over. Delete anything older than the retention
 *    window.
 *  - `audit.jsonl` is bounded by SIZE, but ROTATED, never truncated. It's the
 *    record backing the read-only guarantee, so deleting history to reclaim
 *    disk would quietly undermine the one thing the file exists for. Rotate to
 *    `audit.jsonl.1 … .N` and keep them.
 *
 * `alerts.jsonl` is deliberately NOT handled here. Its growth is attacker-driven
 * when the webhook listener is exposed, and it's re-read in full on every
 * `get_alert_context` call — so it's bounded at that boundary (see #68), not by
 * a blanket age/size sweep that would race the listener's appends.
 *
 * Every step is best-effort: a missing dir, a permission error, or a file that
 * vanishes mid-sweep must never stop the server from starting. Nothing here
 * throws; failures are swallowed per-item so one bad file can't abort the rest.
 */
export async function runStartupMaintenance(config: Config): Promise<void> {
  await sweepOldScreenshots(config).catch(() => 0);
  await rotateAuditLog(config).catch(() => false);
}

/**
 * Deletes `*.png` files under `<dataDir>/screenshots` whose mtime is older than
 * `config.screenshotRetentionHours`. Returns the number removed. A non-finite
 * or non-positive retention disables the sweep (returns 0 without touching
 * anything). `nowMs` is injectable for tests.
 */
export async function sweepOldScreenshots(config: Config, nowMs: number = Date.now()): Promise<number> {
  const maxAgeMs = config.screenshotRetentionHours * 3_600_000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 0;

  const dir = join(config.dataDir, 'screenshots');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // No screenshots directory yet (or unreadable) — nothing to sweep.
    return 0;
  }

  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.png')) continue;
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      if (nowMs - info.mtimeMs > maxAgeMs) {
        await unlink(file);
        removed += 1;
      }
    } catch {
      // Raced with another writer/sweeper, or a transient FS error — skip this
      // one file rather than aborting the whole sweep.
    }
  }
  return removed;
}

/**
 * Rotates `<dataDir>/audit.jsonl` when it exceeds `config.auditMaxBytes`,
 * retaining up to `config.auditKeep` older generations (`audit.jsonl.1` …
 * `.auditKeep`). Returns true if a rotation happened. The live log is renamed
 * to `.1` (not truncated), so no audit line is lost; a fresh `audit.jsonl` is
 * created by the next `appendAuditRecord`. A non-finite or non-positive
 * `auditMaxBytes` disables rotation.
 */
export async function rotateAuditLog(config: Config): Promise<boolean> {
  const maxBytes = config.auditMaxBytes;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return false;

  const base = join(config.dataDir, 'audit.jsonl');
  let size: number;
  try {
    size = (await stat(base)).size;
  } catch {
    // No audit log yet — nothing to rotate.
    return false;
  }
  if (size <= maxBytes) return false;

  const keep = Math.max(1, Math.floor(config.auditKeep));
  // Oldest-first so no rename clobbers a generation a later step still needs:
  // drop what would fall off the end, shift each kept generation down by one,
  // then move the live log into slot .1.
  await unlink(`${base}.${keep}`).catch(() => undefined);
  for (let i = keep - 1; i >= 1; i -= 1) {
    await rename(`${base}.${i}`, `${base}.${i + 1}`).catch(() => undefined);
  }
  await rename(base, `${base}.1`).catch(() => undefined);
  return true;
}
