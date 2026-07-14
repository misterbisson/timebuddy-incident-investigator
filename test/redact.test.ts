import { describe, expect, it } from 'vitest';
import { redact } from '../src/security/redact.js';

describe('redact', () => {
  it('masks secret-shaped keys regardless of nesting', () => {
    const input = {
      datasource: { url: 'https://x', password: 'hunter2', nested: { apiKey: 'abc123' } },
      token: 'zzz',
    };
    const result = redact(input) as typeof input;
    expect(result.datasource.password).toBe('[REDACTED]');
    expect((result.datasource.nested as { apiKey: string }).apiKey).toBe('[REDACTED]');
    expect(result.token).toBe('[REDACTED]');
    expect(result.datasource.url).toBe('https://x');
  });

  it('masks string values matching a custom pattern anywhere in an object', () => {
    const patterns = [/acct-\d{6}/];
    const input = { labels: { account: 'acct-123456' }, text: 'seen on acct-123456 today' };
    const result = redact(input, patterns) as typeof input;
    expect(result.labels.account).toBe('[REDACTED]');
    expect(result.text).toBe('seen on [REDACTED] today');
  });

  it('redacts within arrays', () => {
    const result = redact([{ token: 'a' }, { token: 'b' }]) as Array<{ token: string }>;
    expect(result[0]!.token).toBe('[REDACTED]');
    expect(result[1]!.token).toBe('[REDACTED]');
  });

  it('leaves non-matching data untouched', () => {
    const input = { service: 'checkout', count: 5, ok: true, nothing: null };
    expect(redact(input)).toEqual(input);
  });
});
