import { mkdir, appendFile, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { WebhookPayload } from '../alerts/ingest.js';

export interface StoredWebhook {
  receivedAt: string;
  payload: WebhookPayload;
}

/**
 * How much of the file to pull in per backwards step. Every caller here
 * wants the newest record(s), and the newest record is the last line, so one
 * chunk almost always answers the question regardless of how large the file
 * has grown.
 */
const TAIL_CHUNK_BYTES = 64 * 1024;

const NEWLINE = 0x0a;

function alertsFilePath(config: Config): string {
  return join(config.dataDir, 'alerts.jsonl');
}

async function ensureDataDir(config: Config): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
}

/** Appends one received webhook payload as a JSON line. Never mutates Grafana. */
export async function storeWebhook(payload: WebhookPayload, config: Config): Promise<void> {
  await ensureDataDir(config);
  const record: StoredWebhook = { receivedAt: new Date().toISOString(), payload };
  await appendFile(alertsFilePath(config), `${JSON.stringify(record)}\n`, 'utf8');
}

// A single malformed/truncated line (partial write from a crash, disk full,
// etc.) shouldn't break reads of every other record in the file.
function parseLine(line: string): StoredWebhook | undefined {
  if (!line) return undefined;
  try {
    return JSON.parse(line) as StoredWebhook;
  } catch {
    return undefined;
  }
}

/** read() may come up short of the requested length; keep going until it doesn't. */
async function readFully(handle: FileHandle, buf: Buffer, position: number): Promise<void> {
  let filled = 0;
  while (filled < buf.length) {
    const { bytesRead } = await handle.read(buf, filled, buf.length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
}

/**
 * Yields stored webhooks newest-first, reading the file backwards a chunk at
 * a time and parsing only as far as the caller actually consumes.
 *
 * This exists because every consumer below wants the *most recent* matching
 * record, but the previous implementation read and JSON.parse'd the entire
 * history to answer that — so a no-argument `get_alert_context` against a
 * long-lived install was O(all alerts ever received) to fetch exactly one.
 */
async function* readRecordsNewestFirst(config: Config): AsyncGenerator<StoredWebhook> {
  let handle: FileHandle;
  try {
    handle = await open(alertsFilePath(config), 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    let end = size;
    // Bytes of a line whose beginning lies in a chunk we haven't read yet.
    // Bounded in practice by the listener's 5 MB body cap, since that's the
    // largest single line that can be written.
    let carry = Buffer.alloc(0);

    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      const buf = Buffer.alloc(end - start);
      await readFully(handle, buf, start);
      const combined = Buffer.concat([buf, carry]);

      let complete = combined;
      if (start > 0) {
        const nl = combined.indexOf(NEWLINE);
        if (nl === -1) {
          // No line boundary in this chunk at all — the whole thing is the
          // tail of a line that starts further back. Carry it and step.
          carry = combined;
          end = start;
          continue;
        }
        carry = combined.subarray(0, nl);
        complete = combined.subarray(nl + 1);
      } else {
        carry = Buffer.alloc(0);
      }

      // Splitting is done on bytes above and only decoded here, where
      // `complete` is known to begin at byte 0 or just past a newline. That
      // ordering is what keeps a multi-byte character that straddles a chunk
      // boundary from being decoded as two halves and corrupted.
      const lines = complete.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const record = parseLine(lines[i]!);
        if (record) yield record;
      }
      end = start;
    }
  } finally {
    await handle.close();
  }
}

export async function getLatestWebhook(config: Config): Promise<StoredWebhook | undefined> {
  for await (const record of readRecordsNewestFirst(config)) return record;
  return undefined;
}

export async function getWebhookByFingerprint(
  fingerprint: string,
  config: Config,
): Promise<StoredWebhook | undefined> {
  for await (const record of readRecordsNewestFirst(config)) {
    if ((record.payload?.alerts ?? []).some((a) => a.fingerprint === fingerprint)) return record;
  }
  return undefined;
}

export async function listRecentWebhooks(config: Config, limit = 20): Promise<StoredWebhook[]> {
  const recent: StoredWebhook[] = [];
  for await (const record of readRecordsNewestFirst(config)) {
    recent.push(record);
    if (recent.length >= limit) break;
  }
  return recent;
}
