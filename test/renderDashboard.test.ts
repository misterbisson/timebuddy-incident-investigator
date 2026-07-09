import { describe, expect, it } from 'vitest';
import { resolveRenderWindow } from '../src/tools/renderDashboard.js';

describe('resolveRenderWindow', () => {
  const nowMs = Date.parse('2026-07-07T12:00:00Z');

  it('prefers explicit fromMs/toMs over everything else', () => {
    const result = resolveRenderWindow({
      inputFromMs: 100,
      inputToMs: 200,
      urlFromRaw: 'now-1h',
      urlToRaw: 'now',
      dashboardTimeFrom: 'now-6h',
      dashboardTimeTo: 'now',
      nowMs,
    });
    expect(result).toEqual({ fromMs: 100, toMs: 200 });
  });

  it('falls back to the url\'s own from/to when no explicit override is given', () => {
    const result = resolveRenderWindow({ urlFromRaw: 'now-1h', urlToRaw: 'now', nowMs });
    expect(result).toEqual({ fromMs: nowMs - 3_600_000, toMs: nowMs });
  });

  it('falls back to the dashboard\'s own saved default time range when neither an explicit nor a url time is given', () => {
    const result = resolveRenderWindow({ dashboardTimeFrom: 'now-6h', dashboardTimeTo: 'now', nowMs });
    expect(result).toEqual({ fromMs: nowMs - 6 * 3_600_000, toMs: nowMs });
  });

  it('resolves fromMs and toMs independently across tiers, e.g. an explicit fromMs with only a url-provided to', () => {
    const result = resolveRenderWindow({ inputFromMs: 500, urlToRaw: 'now', nowMs });
    expect(result).toEqual({ fromMs: 500, toMs: nowMs });
  });

  it('throws when no source provides a usable time boundary', () => {
    expect(() => resolveRenderWindow({ nowMs })).toThrow(/Could not determine a time window/);
  });

  it('throws when only one side of the window is resolvable', () => {
    expect(() => resolveRenderWindow({ inputFromMs: 100, nowMs })).toThrow(/Could not determine a time window/);
  });
});
