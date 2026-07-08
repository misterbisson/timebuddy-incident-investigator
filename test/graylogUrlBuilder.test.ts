import { describe, expect, it } from 'vitest';
import { buildGraylogSearchUrl } from '../src/graylog/urlBuilder.js';

describe('buildGraylogSearchUrl', () => {
  it('builds a bare unscoped search link with just a query', () => {
    const url = new URL(buildGraylogSearchUrl('https://graylog.example.com', 'service:frontend'));
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe('service:frontend');
    expect(url.searchParams.has('rangetype')).toBe(false);
  });

  it('strips a trailing slash from the base URL', () => {
    const url = buildGraylogSearchUrl('https://graylog.example.com/', 'x');
    expect(url.startsWith('https://graylog.example.com/search')).toBe(true);
  });

  it('scopes to a stream via the /streams/:id/search path', () => {
    const url = new URL(buildGraylogSearchUrl('https://graylog.example.com', 'x', { streamId: 'abc123' }));
    expect(url.pathname).toBe('/streams/abc123/search');
  });

  it('adds an absolute time range when both fromMs and toMs are given', () => {
    const url = new URL(
      buildGraylogSearchUrl('https://graylog.example.com', 'x', { fromMs: Date.parse('2026-01-01T00:00:00Z'), toMs: Date.parse('2026-01-01T01:00:00Z') }),
    );
    expect(url.searchParams.get('rangetype')).toBe('absolute');
    expect(url.searchParams.get('from')).toBe('2026-01-01T00:00:00.000Z');
    expect(url.searchParams.get('to')).toBe('2026-01-01T01:00:00.000Z');
  });

  it('omits the time range entirely when only one of fromMs/toMs is given', () => {
    const url = new URL(buildGraylogSearchUrl('https://graylog.example.com', 'x', { fromMs: 1000 }));
    expect(url.searchParams.has('rangetype')).toBe(false);
  });
});
