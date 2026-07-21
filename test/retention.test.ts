import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rotateAuditLog, runStartupMaintenance, sweepOldScreenshots } from '../src/security/retention.js';
import type { Config } from '../src/config.js';

let dataDir: string;

function config(overrides: Partial<Config> = {}): Config {
  return {
    connections: [],
    tlsVerify: true,
    requestTimeoutMs: 1000,
    screenshotTimeoutMs: 45000,
    maxConcurrency: 4,
    maxLookbackHours: 720,
    maxDataPoints: 2000,
    redactionPatterns: [],
    dataDir,
    webhookPort: 4318,
    webhookBindAddress: '127.0.0.1',
    screenshotRetentionHours: 168,
    auditMaxBytes: 5_000_000,
    auditKeep: 5,
    ...overrides,
  };
}

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

async function writeScreenshot(name: string, ageHours: number, baseMs: number = NOW): Promise<string> {
  const dir = join(dataDir, 'screenshots');
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, 'png-bytes');
  const mtime = new Date(baseMs - ageHours * HOUR);
  await utimes(file, mtime, mtime);
  return file;
}

async function screenshotNames(): Promise<string[]> {
  return (await readdir(join(dataDir, 'screenshots'))).sort();
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'retention-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('sweepOldScreenshots', () => {
  it('deletes PNGs older than the retention window and keeps recent ones', async () => {
    await writeScreenshot('old.png', 200); // older than 168h
    await writeScreenshot('borderline.png', 167); // just inside the window
    await writeScreenshot('fresh.png', 1);

    const removed = await sweepOldScreenshots(config({ screenshotRetentionHours: 168 }), NOW);

    expect(removed).toBe(1);
    expect(await screenshotNames()).toEqual(['borderline.png', 'fresh.png']);
  });

  it('leaves non-PNG files alone even when they are old', async () => {
    await writeScreenshot('old.png', 500);
    const dir = join(dataDir, 'screenshots');
    const keepFile = join(dir, 'notes.txt');
    await writeFile(keepFile, 'keep me');
    const old = new Date(NOW - 500 * HOUR);
    await utimes(keepFile, old, old);

    const removed = await sweepOldScreenshots(config(), NOW);

    expect(removed).toBe(1);
    expect(await screenshotNames()).toEqual(['notes.txt']);
  });

  it('returns 0 without throwing when the screenshots directory does not exist', async () => {
    await expect(sweepOldScreenshots(config(), NOW)).resolves.toBe(0);
  });

  it('is disabled (deletes nothing) when retention is zero or negative', async () => {
    await writeScreenshot('ancient.png', 100_000);
    expect(await sweepOldScreenshots(config({ screenshotRetentionHours: 0 }), NOW)).toBe(0);
    expect(await sweepOldScreenshots(config({ screenshotRetentionHours: -5 }), NOW)).toBe(0);
    expect(await screenshotNames()).toEqual(['ancient.png']);
  });
});

describe('rotateAuditLog', () => {
  async function writeAudit(name: string, bytes: number): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, name), 'a'.repeat(bytes));
  }

  it('rotates the live log to .1 and shifts existing generations down when over the size cap', async () => {
    await writeAudit('audit.jsonl', 100);
    await writeAudit('audit.jsonl.1', 50);

    const rotated = await rotateAuditLog(config({ auditMaxBytes: 10, auditKeep: 5 }));

    expect(rotated).toBe(true);
    // Live log moved to .1 (its 100 bytes), the old .1 shifted to .2 (50 bytes).
    expect((await stat(join(dataDir, 'audit.jsonl.1'))).size).toBe(100);
    expect((await stat(join(dataDir, 'audit.jsonl.2'))).size).toBe(50);
    // The live path is now gone; the next append recreates it.
    await expect(stat(join(dataDir, 'audit.jsonl'))).rejects.toThrow();
  });

  it('preserves content on rotation rather than truncating', async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'audit.jsonl'), 'line-one\nline-two\n');

    await rotateAuditLog(config({ auditMaxBytes: 1 }));

    expect(await readFile(join(dataDir, 'audit.jsonl.1'), 'utf8')).toBe('line-one\nline-two\n');
  });

  it('drops the oldest generation beyond auditKeep', async () => {
    await writeAudit('audit.jsonl', 100);
    await writeAudit('audit.jsonl.1', 11);
    await writeAudit('audit.jsonl.2', 12); // == keep; must be dropped, not shifted to .3

    await rotateAuditLog(config({ auditMaxBytes: 10, auditKeep: 2 }));

    expect((await stat(join(dataDir, 'audit.jsonl.1'))).size).toBe(100); // live → .1
    expect((await stat(join(dataDir, 'audit.jsonl.2'))).size).toBe(11); // old .1 → .2
    await expect(stat(join(dataDir, 'audit.jsonl.3'))).rejects.toThrow(); // nothing spilled past keep
  });

  it('does not rotate when the log is at or under the size cap', async () => {
    await writeAudit('audit.jsonl', 100);
    expect(await rotateAuditLog(config({ auditMaxBytes: 100 }))).toBe(false);
    expect((await stat(join(dataDir, 'audit.jsonl'))).size).toBe(100);
    await expect(stat(join(dataDir, 'audit.jsonl.1'))).rejects.toThrow();
  });

  it('returns false without throwing when there is no audit log', async () => {
    await expect(rotateAuditLog(config({ auditMaxBytes: 10 }))).resolves.toBe(false);
  });

  it('is disabled when auditMaxBytes is zero or negative', async () => {
    await writeAudit('audit.jsonl', 10_000);
    expect(await rotateAuditLog(config({ auditMaxBytes: 0 }))).toBe(false);
    expect(await rotateAuditLog(config({ auditMaxBytes: -1 }))).toBe(false);
    expect((await stat(join(dataDir, 'audit.jsonl'))).size).toBe(10_000);
  });
});

describe('runStartupMaintenance', () => {
  it('sweeps screenshots and rotates the audit log in one pass', async () => {
    // runStartupMaintenance uses the real Date.now() for the age sweep, so age
    // these relative to real now rather than the fixed NOW the unit tests use.
    await writeScreenshot('old.png', 1000, Date.now());
    await writeScreenshot('fresh.png', 1, Date.now());
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'audit.jsonl'), 'x'.repeat(200));

    await runStartupMaintenance(config({ screenshotRetentionHours: 168, auditMaxBytes: 10 }));

    expect(await screenshotNames()).toEqual(['fresh.png']);
    expect((await stat(join(dataDir, 'audit.jsonl.1'))).size).toBe(200);
  });

  it('never rejects even if the data dir is unusable', async () => {
    // dataDir points at a path whose parent is a file, so any FS op under it
    // errors — runStartupMaintenance must still resolve.
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'not-a-dir'), 'x');
    await expect(
      runStartupMaintenance(config({ dataDir: join(dataDir, 'not-a-dir') })),
    ).resolves.toBeUndefined();
  });
});
