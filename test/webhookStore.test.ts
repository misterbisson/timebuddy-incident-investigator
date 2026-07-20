import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLatestWebhook,
  getWebhookByFingerprint,
  listRecentWebhooks,
  storeWebhook,
  type StoredWebhook,
} from '../src/webhook/store.js';
import type { Config } from '../src/config.js';
import type { WebhookPayload } from '../src/alerts/ingest.js';

let dataDir: string;

function config(): Config {
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
  };
}

function payload(fingerprint: string, extra: Record<string, unknown> = {}): WebhookPayload {
  return {
    alerts: [{ fingerprint, labels: { alertname: `alert-${fingerprint}` }, ...extra }],
  } as unknown as WebhookPayload;
}

/** Writes raw lines, bypassing storeWebhook, so a test can control the exact file bytes. */
async function writeLines(lines: string[]): Promise<void> {
  await writeFile(join(dataDir, 'alerts.jsonl'), lines.map((l) => `${l}\n`).join(''), 'utf8');
}

function line(fingerprint: string, padding = ''): string {
  const record: StoredWebhook = {
    receivedAt: `2026-07-20T00:00:00.000Z`,
    payload: payload(fingerprint, padding ? { padding } : {}),
  };
  return JSON.stringify(record);
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'webhook-store-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('an absent or empty store', () => {
  it('reports no latest webhook rather than throwing', async () => {
    expect(await getLatestWebhook(config())).toBeUndefined();
    expect(await getWebhookByFingerprint('nope', config())).toBeUndefined();
    expect(await listRecentWebhooks(config())).toEqual([]);
  });

  it('treats a zero-byte file the same as a missing one', async () => {
    await writeFile(join(dataDir, 'alerts.jsonl'), '', 'utf8');
    expect(await getLatestWebhook(config())).toBeUndefined();
  });
});

describe('getLatestWebhook', () => {
  it('returns the most recently appended record', async () => {
    await storeWebhook(payload('first'), config());
    await storeWebhook(payload('second'), config());
    await storeWebhook(payload('third'), config());

    const latest = await getLatestWebhook(config());
    expect(latest?.payload.alerts[0]?.fingerprint).toBe('third');
  });

  it('skips a torn final line and falls back to the last intact record', async () => {
    await writeLines([line('good')]);
    // A crash mid-append leaves exactly this: a partial JSON line with no
    // closing brace. It must not shadow the record before it.
    await appendFile(join(dataDir, 'alerts.jsonl'), '{"receivedAt":"2026-', 'utf8');

    const latest = await getLatestWebhook(config());
    expect(latest?.payload.alerts[0]?.fingerprint).toBe('good');
  });

  it('reads a final line that was never newline-terminated', async () => {
    await writeFile(join(dataDir, 'alerts.jsonl'), `${line('a')}\n${line('b')}`, 'utf8');
    expect((await getLatestWebhook(config()))?.payload.alerts[0]?.fingerprint).toBe('b');
  });
});

describe('reading backwards across chunk boundaries', () => {
  // The reader steps backwards in 64 KiB chunks, so anything that spans a
  // multiple of that is where a naive tail read goes wrong.
  const CHUNK = 64 * 1024;

  it('finds the newest record when the file is many chunks long', async () => {
    // ~1 KiB of padding per line, so 300 lines comfortably exceeds 4 chunks.
    const lines = Array.from({ length: 300 }, (_, i) => line(`fp-${i}`, 'x'.repeat(1024)));
    await writeLines(lines);

    expect((await getLatestWebhook(config()))?.payload.alerts[0]?.fingerprint).toBe('fp-299');
  });

  it('finds a record that sits in the oldest chunk, reached only by walking back', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => line(`fp-${i}`, 'x'.repeat(1024)));
    await writeLines(lines);

    const found = await getWebhookByFingerprint('fp-0', config());
    expect(found?.payload.alerts[0]?.fingerprint).toBe('fp-0');
  });

  it('reads a single line longer than one whole chunk', async () => {
    // The carry buffer has to accumulate across several backwards steps
    // before this line is even parseable.
    await writeLines([line('small'), line('huge', 'y'.repeat(CHUNK * 3))]);

    const latest = await getLatestWebhook(config());
    expect(latest?.payload.alerts[0]?.fingerprint).toBe('huge');
  });

  it('does not corrupt a multi-byte character that straddles a chunk boundary', async () => {
    // "😀" is 4 bytes in UTF-8. The reader's first backwards step reads
    // [size-CHUNK, size); its lower edge (`size-CHUNK`) is an arbitrary byte
    // position that can fall inside a multi-byte character. This test forces
    // exactly that, sweeping the boundary through all four bytes of the emoji
    // so at least the two interior alignments genuinely split it.
    const emoji = '😀';
    const tail = line('tail');
    const bytesAfterEmojiLine = Buffer.byteLength(`${tail}\n`);
    // The emoji is the first byte of `padding`, at a fixed offset O from file
    // start (padding length doesn't move it). O is measured, not assumed.
    const probe = line('head', emoji);
    const emojiStart = Buffer.byteLength(probe.slice(0, probe.indexOf(emoji)));

    let crossings = 0;
    for (let boundaryInsideEmoji = 0; boundaryInsideEmoji < 4; boundaryInsideEmoji++) {
      await rm(join(dataDir, 'alerts.jsonl'), { force: true });
      // We want (size - CHUNK) == emojiStart + boundaryInsideEmoji. Each 'z'
      // in the padding adds exactly one byte to the file, so build once at a
      // guess and correct the pad by however many bytes we overshot — no need
      // to model the JSON envelope's exact byte count.
      const target = emojiStart + boundaryInsideEmoji;
      let pad = CHUNK; // any value larger than `target`; corrected below.
      const sizeAt = (p: number) => Buffer.byteLength(`${line('head', `${emoji}${'z'.repeat(p)}`)}\n`) + bytesAfterEmojiLine;
      pad += target - (sizeAt(pad) - CHUNK);
      const head = line('head', `${emoji}${'z'.repeat(pad)}`);
      await writeLines([head, tail]);

      const boundary = sizeAt(pad) - CHUNK;
      if (boundary > emojiStart && boundary < emojiStart + 4) crossings++;

      const found = await getWebhookByFingerprint('head', config());
      const padding = (found?.payload.alerts[0] as { padding?: string } | undefined)?.padding;
      expect(padding?.startsWith(emoji), `boundary at emoji byte ${boundaryInsideEmoji}`).toBe(true);
    }
    // Guard against a future refactor that silently stops splitting the emoji
    // and turns this into a test of nothing.
    expect(crossings).toBeGreaterThanOrEqual(2);
  });
});

describe('listRecentWebhooks', () => {
  it('returns newest first, capped at the limit', async () => {
    await writeLines(['a', 'b', 'c', 'd'].map((f) => line(f)));

    const recent = await listRecentWebhooks(config(), 2);
    expect(recent.map((r) => r.payload.alerts[0]?.fingerprint)).toEqual(['d', 'c']);
  });

  it('returns everything it has when there are fewer records than the limit', async () => {
    await writeLines([line('only')]);
    expect(await listRecentWebhooks(config(), 20)).toHaveLength(1);
  });
});

describe('getWebhookByFingerprint', () => {
  it('prefers the most recent record carrying that fingerprint', async () => {
    await writeLines([
      JSON.stringify({ receivedAt: 'older', payload: payload('dup') }),
      JSON.stringify({ receivedAt: 'newer', payload: payload('dup') }),
    ]);

    expect((await getWebhookByFingerprint('dup', config()))?.receivedAt).toBe('newer');
  });

  it('tolerates a stored record with no alerts array', async () => {
    await writeLines([JSON.stringify({ receivedAt: 'x', payload: {} }), line('real')]);
    expect((await getWebhookByFingerprint('real', config()))?.payload.alerts[0]?.fingerprint).toBe('real');
  });
});

describe('read amplification', () => {
  // This is the actual defect in #68: answering "what was the last alert?"
  // used to cost a full read and JSON.parse of every alert ever received.
  it('parses a handful of lines, not the whole history, to get the latest', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => line(`fp-${i}`));
    await writeLines(lines);

    const parse = vi.spyOn(JSON, 'parse');
    const latest = await getLatestWebhook(config());

    expect(latest?.payload.alerts[0]?.fingerprint).toBe('fp-1999');
    // One 64 KiB chunk covers a few hundred of these ~180-byte lines, and
    // only the newest is consumed before the generator is abandoned — but
    // the guard that matters is simply "sub-linear in file length".
    expect(parse.mock.calls.length).toBeLessThan(lines.length / 2);
  });

  it('stops parsing as soon as listRecentWebhooks has its limit', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => line(`fp-${i}`));
    await writeLines(lines);

    const parse = vi.spyOn(JSON, 'parse');
    const recent = await listRecentWebhooks(config(), 5);

    expect(recent).toHaveLength(5);
    expect(parse.mock.calls.length).toBeLessThan(lines.length / 2);
  });
});
