import { describe, expect, it } from 'vitest';
import { buildGraylogSearchUrl } from '../src/graylog/urlBuilder.js';

describe('buildGraylogSearchUrl', () => {
  it('builds a bare global-search URL with no streamId', () => {
    const url = new URL(
      buildGraylogSearchUrl('https://graylog.example.com', { query: 'service:frontend', fromMs: 1000, toMs: 2000 }),
    );
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe('service:frontend');
    expect(url.searchParams.get('rangetype')).toBe('absolute');
    expect(url.searchParams.get('from')).toBe(new Date(1000).toISOString());
    expect(url.searchParams.get('to')).toBe(new Date(2000).toISOString());
  });

  it('strips a trailing slash from the base URL', () => {
    const url = buildGraylogSearchUrl('https://graylog.example.com/', { query: '*', fromMs: 0, toMs: 1 });
    expect(url.startsWith('https://graylog.example.com/search?')).toBe(true);
  });

  it('scopes the path to a stream when streamId is given', () => {
    const url = new URL(
      buildGraylogSearchUrl('https://graylog.example.com', { query: '*', fromMs: 0, toMs: 1, streamId: 'stream-1' }),
    );
    expect(url.pathname).toBe('/streams/stream-1/search');
  });
});
