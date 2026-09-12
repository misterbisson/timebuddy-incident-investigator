import { describe, expect, it, vi } from 'vitest';
import { resolveRenderWindow } from '../src/tools/renderDashboard.js';

const at = (iso: string) => Date.parse(iso);

describe('resolveRenderWindow', () => {
  // A Tuesday — see dateMath.test.ts.
  const nowMs = at('2026-07-07T12:00:00Z');

  describe('the fallback chain', () => {
    it('prefers explicit fromMs/toMs over everything else', async () => {
      const result = await resolveRenderWindow({
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

    it('falls back to the url\'s own from/to when no explicit override is given', async () => {
      const result = await resolveRenderWindow({ urlFromRaw: 'now-1h', urlToRaw: 'now', nowMs });
      expect(result.fromMs).toBe(nowMs - 3_600_000);
      expect(result.toMs).toBe(nowMs);
    });

    it('falls back to the dashboard\'s own saved default time range when neither an explicit nor a url time is given', async () => {
      const result = await resolveRenderWindow({ dashboardTimeFrom: 'now-6h', dashboardTimeTo: 'now', nowMs });
      expect(result.fromMs).toBe(nowMs - 6 * 3_600_000);
      expect(result.toMs).toBe(nowMs);
    });

    it('resolves fromMs and toMs independently across tiers, e.g. an explicit fromMs with only a url-provided to', async () => {
      const result = await resolveRenderWindow({ inputFromMs: 500, urlToRaw: 'now', nowMs });
      expect(result.fromMs).toBe(500);
      expect(result.toMs).toBe(nowMs);
    });

    it('throws when no source provides a usable time boundary', async () => {
      await expect(resolveRenderWindow({ nowMs })).rejects.toThrow(/Could not determine a time window/);
    });

    it('throws when only one side of the window is resolvable', async () => {
      await expect(resolveRenderWindow({ inputFromMs: 100, nowMs })).rejects.toThrow(/Could not determine a time window/);
    });

    it('ignores an unparseable dashboard default range that a higher tier already superseded', async () => {
      // Only the winning expression per bound is parsed at all — a dashboard
      // saved with a range this parser can't read must not fail a call that
      // never needed it.
      const result = await resolveRenderWindow({
        urlFromRaw: 'now-1h',
        urlToRaw: 'now',
        dashboardTimeFrom: 'sometime last Tuesday',
        dashboardTimeTo: 'whenever',
        nowMs,
      });
      expect(result.fromMs).toBe(nowMs - 3_600_000);
    });
  });

  describe('relative-time resolution', () => {
    it('rounds the "from" bound down and the "to" bound up, per Grafana\'s own range parsing', async () => {
      const result = await resolveRenderWindow({ urlFromRaw: 'now/d', urlToRaw: 'now/d', nowMs });
      expect(result.fromMs).toBe(at('2026-07-07T00:00:00.000Z'));
      expect(result.toMs).toBe(at('2026-07-07T23:59:59.999Z'));
    });

    it('resolves the issue #216 link to a clean 28 days ending at the end of last week', async () => {
      const result = await resolveRenderWindow({
        urlFromRaw: 'now/w-28d',
        urlToRaw: 'now/w-7d',
        urlTimezone: 'UTC',
        dashboardWeekStart: 'monday',
        nowMs,
      });
      expect(result.fromMs).toBe(at('2026-06-08T00:00:00.000Z'));
      expect(result.toMs).toBe(at('2026-07-05T23:59:59.999Z'));
      expect(result.relativeTime).toEqual({
        from: 'now/w-28d',
        to: 'now/w-7d',
        timeZone: 'UTC',
        timeZoneSource: 'url',
        weekStart: 'monday',
        weekStartSource: 'dashboard',
      });
    });

    it('reports nothing extra when both bounds are absolute', async () => {
      const result = await resolveRenderWindow({ inputFromMs: 100, inputToMs: 200, nowMs });
      expect(result.relativeTime).toBeUndefined();
      const fromEpochStrings = await resolveRenderWindow({ urlFromRaw: '100', urlToRaw: '200', nowMs });
      expect(fromEpochStrings.relativeTime).toBeUndefined();
    });

    it('omits weekStart unless a "/w" round actually made it matter', async () => {
      const result = await resolveRenderWindow({ urlFromRaw: 'now-1h', urlToRaw: 'now', nowMs });
      // Neither the zone nor the week-start bore on a fixed-duration shift,
      // so neither is reported — only the expressions themselves.
      expect(result.relativeTime).toEqual({ from: 'now-1h', to: 'now' });
    });

    it('reports the documented defaults as such when nothing else settles them', async () => {
      const result = await resolveRenderWindow({ urlFromRaw: 'now/w', urlToRaw: 'now', nowMs });
      expect(result.relativeTime).toMatchObject({
        timeZone: 'UTC',
        timeZoneSource: 'default',
        weekStart: 'sunday',
        weekStartSource: 'default',
      });
      expect(result.fromMs).toBe(at('2026-07-05T00:00:00.000Z'));
    });
  });

  describe('zone and week-start precedence', () => {
    const preferences = (prefs: { timezone?: string; weekStart?: string }) => vi.fn(async () => prefs);

    it('prefers the link\'s own timezone param over the dashboard\'s', async () => {
      const lookup = preferences({ timezone: 'Europe/Berlin' });
      const result = await resolveRenderWindow({
        urlFromRaw: 'now/d',
        urlToRaw: 'now',
        urlTimezone: 'America/Los_Angeles',
        dashboardTimezone: 'Asia/Tokyo',
        nowMs,
        preferences: lookup,
      });
      expect(result.relativeTime).toMatchObject({ timeZone: 'America/Los_Angeles', timeZoneSource: 'url' });
      expect(result.fromMs).toBe(at('2026-07-07T07:00:00.000Z'));
      expect(lookup).not.toHaveBeenCalled();
    });

    it('falls through the link\'s "browser" timezone to the dashboard\'s, since there is no browser here', async () => {
      const result = await resolveRenderWindow({
        urlFromRaw: 'now/d',
        urlToRaw: 'now',
        urlTimezone: 'browser',
        dashboardTimezone: 'America/Los_Angeles',
        nowMs,
      });
      expect(result.relativeTime).toMatchObject({ timeZone: 'America/Los_Angeles', timeZoneSource: 'dashboard' });
    });

    it('reads the connection\'s Grafana preferences when neither the link nor the dashboard settles it', async () => {
      const lookup = preferences({ timezone: 'America/Los_Angeles', weekStart: 'monday' });
      const result = await resolveRenderWindow({
        urlFromRaw: 'now/w',
        urlToRaw: 'now',
        dashboardTimezone: '',
        dashboardWeekStart: '',
        nowMs,
        preferences: lookup,
      });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(result.relativeTime).toMatchObject({
        timeZone: 'America/Los_Angeles',
        timeZoneSource: 'connection-preferences',
        weekStart: 'monday',
        weekStartSource: 'connection-preferences',
      });
      // Monday-start week in Los Angeles: 2026-07-06 00:00 PDT.
      expect(result.fromMs).toBe(at('2026-07-06T07:00:00.000Z'));
    });

    it('lets the dashboard\'s weekStart win over the connection preference, as Grafana\'s own frontend does', async () => {
      const lookup = preferences({ weekStart: 'sunday' });
      const result = await resolveRenderWindow({
        urlFromRaw: 'now/w',
        urlToRaw: 'now',
        urlTimezone: 'UTC',
        dashboardWeekStart: 'monday',
        nowMs,
        preferences: lookup,
      });
      expect(result.relativeTime).toMatchObject({ weekStart: 'monday', weekStartSource: 'dashboard' });
      expect(lookup).not.toHaveBeenCalled();
    });

    it('still falls back to the documented defaults when the preferences themselves are unset', async () => {
      const lookup = preferences({ timezone: 'browser', weekStart: '' });
      const result = await resolveRenderWindow({ urlFromRaw: 'now/w', urlToRaw: 'now', nowMs, preferences: lookup });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(result.relativeTime).toMatchObject({
        timeZone: 'UTC',
        timeZoneSource: 'default',
        weekStart: 'sunday',
        weekStartSource: 'default',
      });
    });

    it('skips the preferences lookup entirely for a zone-independent window', async () => {
      const lookup = preferences({ timezone: 'America/Los_Angeles' });
      await resolveRenderWindow({ urlFromRaw: 'now-90m', urlToRaw: 'now', nowMs, preferences: lookup });
      expect(lookup).not.toHaveBeenCalled();
    });

    it('skips the preferences lookup when both bounds were given as epoch ms', async () => {
      const lookup = preferences({ timezone: 'America/Los_Angeles' });
      await resolveRenderWindow({ inputFromMs: 100, inputToMs: 200, urlFromRaw: 'now/d', nowMs, preferences: lookup });
      expect(lookup).not.toHaveBeenCalled();
    });

    it('skips a zone this runtime cannot resolve and reports what it discarded', async () => {
      // Falling through beats failing: one typo'd (or ICU-unknown) `timezone`
      // field on a dashboard would otherwise take out every window on it.
      const result = await resolveRenderWindow({
        urlFromRaw: 'now/d',
        urlToRaw: 'now',
        dashboardTimezone: 'Mars/Olympus_Mons',
        nowMs,
      });
      expect(result.fromMs).toBe(at('2026-07-07T00:00:00.000Z'));
      expect(result.relativeTime).toMatchObject({
        timeZone: 'UTC',
        timeZoneSource: 'default',
        timeZoneIgnored: ['Mars/Olympus_Mons'],
      });
    });

    it('falls through an unusable zone to the next tier that can answer', async () => {
      const result = await resolveRenderWindow({
        urlFromRaw: 'now/d',
        urlToRaw: 'now',
        urlTimezone: 'Mars/Olympus_Mons',
        dashboardTimezone: 'America/Los_Angeles',
        nowMs,
      });
      expect(result.relativeTime).toMatchObject({
        timeZone: 'America/Los_Angeles',
        timeZoneSource: 'dashboard',
        timeZoneIgnored: ['Mars/Olympus_Mons'],
      });
    });

    it('does not fail a window the zone plays no part in, which is what an unusable zone used to do', async () => {
      // All three of these work with no zone at all; none should care that the
      // dashboard's saved one is unusable.
      for (const args of [
        { urlFromRaw: 'now-1h', urlToRaw: 'now' },
        { urlFromRaw: '100', urlToRaw: '200' },
        { urlFromRaw: 'now-30d', urlToRaw: 'now' },
      ]) {
        const result = await resolveRenderWindow({ ...args, dashboardTimezone: 'Mars/Olympus_Mons', nowMs });
        expect(result.toMs).toBeGreaterThan(result.fromMs);
      }
    });

    it('resolves a zone-less absolute bound against the connection\'s zone, and reports it', async () => {
      // Not "relative", but its instant still depends on a zone, so it is
      // resolved and reported like one rather than falling to the host's zone.
      const result = await resolveRenderWindow({
        urlFromRaw: '2026-03-01T00:00:00',
        urlToRaw: '2026-03-02T00:00:00',
        dashboardTimezone: 'America/Los_Angeles',
        nowMs,
      });
      expect(result.fromMs).toBe(at('2026-03-01T08:00:00Z'));
      expect(result.relativeTime).toMatchObject({
        from: '2026-03-01T00:00:00',
        timeZone: 'America/Los_Angeles',
        timeZoneSource: 'dashboard',
      });
    });
  });
});
