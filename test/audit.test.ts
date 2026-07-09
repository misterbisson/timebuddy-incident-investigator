import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAuditRecord, withAudit } from '../src/security/audit.js';
import type { Config } from '../src/config.js';

let dataDir: string;

function config(redactionPatterns: RegExp[] = []): Config {
  return {
    connections: [],
    tlsVerify: true,
    requestTimeoutMs: 1000,
    screenshotTimeoutMs: 45000,
    maxConcurrency: 4,
    maxLookbackHours: 720,
    maxDataPoints: 2000,
    redactionPatterns,
    dataDir,
    webhookPort: 4318,
  };
}

async function readAuditLines(): Promise<unknown[]> {
  const text = await readFile(join(dataDir, 'audit.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'audit-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('appendAuditRecord', () => {
  it('redacts a customer-identifier pattern inside argsSummary before writing', async () => {
    await appendAuditRecord(
      {
        timestamp: new Date(0).toISOString(),
        tool: 'export_panel_csv',
        argsSummary: { url: 'https://grafana.example.com/d/x?var-customer=acme-corp' },
        outcome: 'ok',
        durationMs: 1,
      },
      config([/acme-corp/]),
    );
    const [record] = (await readAuditLines()) as Array<{ argsSummary: { url: string } }>;
    expect(record!.argsSummary.url).not.toContain('acme-corp');
    expect(record!.argsSummary.url).toContain('[REDACTED]');
  });

  it('redacts a customer-identifier pattern inside errorMessage before writing', async () => {
    await appendAuditRecord(
      {
        timestamp: new Date(0).toISOString(),
        tool: 'get_alert_context',
        argsSummary: {},
        outcome: 'error',
        errorMessage: 'Could not resolve dashboard for customer acme-corp',
        durationMs: 1,
      },
      config([/acme-corp/]),
    );
    const [record] = (await readAuditLines()) as Array<{ errorMessage: string }>;
    expect(record!.errorMessage).not.toContain('acme-corp');
  });
});

describe('withAudit', () => {
  it('redacts argsSummary written by a successful call', async () => {
    await withAudit('find_related_dashboards', { query: 'acme-corp' }, config([/acme-corp/]), async () => 'ok');
    const [record] = (await readAuditLines()) as Array<{ argsSummary: { query: string } }>;
    expect(record!.argsSummary.query).toBe('[REDACTED]');
  });
});
