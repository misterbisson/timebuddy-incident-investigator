import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { redact } from './redact.js';

export interface AuditRecord {
  timestamp: string;
  tool: string;
  argsSummary: unknown;
  outcome: 'ok' | 'error';
  errorMessage?: string;
  durationMs: number;
}

/**
 * Appends one line per tool invocation to a local, append-only audit log.
 * Redacts argsSummary/errorMessage itself rather than trusting every call
 * site to pre-scrub — a few tools log raw urls/labels that can carry
 * customer-identifier values, and redaction is meant to be a hard guarantee.
 */
export async function appendAuditRecord(record: AuditRecord, config: Config): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const redacted: AuditRecord = {
    ...record,
    argsSummary: redact(record.argsSummary, config.redactionPatterns),
    errorMessage:
      record.errorMessage !== undefined
        ? (redact(record.errorMessage, config.redactionPatterns) as string)
        : undefined,
  };
  await appendFile(join(config.dataDir, 'audit.jsonl'), `${JSON.stringify(redacted)}\n`, 'utf8');
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
