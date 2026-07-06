import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';

export interface AuditRecord {
  timestamp: string;
  tool: string;
  argsSummary: unknown;
  outcome: 'ok' | 'error';
  errorMessage?: string;
  durationMs: number;
}

/** Appends one line per tool invocation to a local, append-only audit log. */
export async function appendAuditRecord(record: AuditRecord, config: Config): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  await appendFile(join(config.dataDir, 'audit.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
}

/** Wraps a tool handler with timing + audit logging. Never throws itself. */
export async function withAudit<T>(
  toolName: string,
  argsSummary: unknown,
  config: Config,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    await appendAuditRecord(
      { timestamp: new Date().toISOString(), tool: toolName, argsSummary, outcome: 'ok', durationMs: Date.now() - start },
      config,
    ).catch(() => undefined);
    return result;
  } catch (err) {
    await appendAuditRecord(
      {
        timestamp: new Date().toISOString(),
        tool: toolName,
        argsSummary,
        outcome: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      },
      config,
    ).catch(() => undefined);
    throw err;
  }
}
