import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { WebhookPayload } from '../alerts/ingest.js';

export interface StoredWebhook {
  receivedAt: string;
  payload: WebhookPayload;
}

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

async function readAll(config: Config): Promise<StoredWebhook[]> {
  let text: string;
  try {
    text = await readFile(alertsFilePath(config), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  // A single malformed/truncated line (partial write from a crash, disk
  // full, etc.) shouldn't break reads of every other record in the file.
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as StoredWebhook];
      } catch {
        return [];
      }
    });
}

export async function getLatestWebhook(config: Config): Promise<StoredWebhook | undefined> {
  const all = await readAll(config);
  return all.at(-1);
}

export async function getWebhookByFingerprint(
  fingerprint: string,
  config: Config,
): Promise<StoredWebhook | undefined> {
  const all = await readAll(config);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i]!.payload.alerts.some((a) => a.fingerprint === fingerprint)) return all[i];
  }
  return undefined;
}

export async function listRecentWebhooks(config: Config, limit = 20): Promise<StoredWebhook[]> {
  const all = await readAll(config);
  return all.slice(-limit).reverse();
}
