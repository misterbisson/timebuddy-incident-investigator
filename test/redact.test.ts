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

  it('masks hyphenated secret-shaped keys (x-api-key, api-key, private-key)', () => {
    const input = { 'x-api-key': 'k1', 'api-key': 'k2', 'private-key': 'k3', 'X-API-KEY': 'k4' };
    const result = redact(input) as Record<string, string>;
    expect(result['x-api-key']).toBe('[REDACTED]');
    expect(result['api-key']).toBe('[REDACTED]');
    expect(result['private-key']).toBe('[REDACTED]');
    expect(result['X-API-KEY']).toBe('[REDACTED]');
  });

  describe('exempt keys', () => {
    const patterns = [/acct-\d{6}/];

    it('leaves an exempt key untouched while still redacting its siblings', () => {
      const input = { exploreUrl: 'https://g/explore?q=acct-123456', query: 'WHERE a = acct-123456' };
      const result = redact(input, patterns, { exempt: ['exploreUrl'] }) as typeof input;
      // Without the exemption this would come back with [REDACTED] spliced into
      // the middle of the URL — a broken link, not a masked one.
      expect(result.exploreUrl).toBe('https://g/explore?q=acct-123456');
      expect(result.query).toBe('WHERE a = [REDACTED]');
    });

    it('still masks a secret-shaped key even when it is listed as exempt', () => {
      // Nothing legitimately needs an unmasked password to function, so the
      // secret-key rule outranks the waiver.
      const result = redact({ token: 'zzz' }, patterns, { exempt: ['token'] }) as { token: string };
      expect(result.token).toBe('[REDACTED]');
    });

    it('exempts nested values under an exempt key, not just strings', () => {
      const input = { exploreUrl: { raw: 'acct-123456' }, other: 'acct-123456' };
      const result = redact(input, patterns, { exempt: ['exploreUrl'] }) as typeof input;
      expect(result.exploreUrl.raw).toBe('acct-123456');
      expect(result.other).toBe('[REDACTED]');
    });

    it('applies the exemption at any depth, since results nest', () => {
      const input = { series: [{ exploreUrl: 'acct-123456', label: 'acct-123456' }] };
      const result = redact(input, patterns, { exempt: ['exploreUrl'] }) as typeof input;
      expect(result.series[0]!.exploreUrl).toBe('acct-123456');
      expect(result.series[0]!.label).toBe('[REDACTED]');
    });

    it('changes nothing when no exemption is passed', () => {
      const input = { exploreUrl: 'acct-123456' };
      expect((redact(input, patterns) as typeof input).exploreUrl).toBe('[REDACTED]');
    });
  });
});
