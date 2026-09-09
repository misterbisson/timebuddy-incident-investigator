import { describe, expect, it, vi } from 'vitest';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { PreferencesDto } from '../src/grafana/types.js';
import { clearConnectionPreferencesCache, fetchConnectionPreferences } from '../src/grafana/preferences.js';

function stub(user: PreferencesDto | Error, org: PreferencesDto | Error) {
  const answer = (value: PreferencesDto | Error) => async () => {
    if (value instanceof Error) throw value;
    return value;
  };
  const getUserPreferences = vi.fn(answer(user));
  const getOrgPreferences = vi.fn(answer(org));
  const client = { getUserPreferences, getOrgPreferences } as unknown as GrafanaClient;
  return { client, getUserPreferences, getOrgPreferences };
}

describe('fetchConnectionPreferences', () => {
  it('lets a user preference override the org one', async () => {
    const { client } = stub({ timezone: 'Asia/Tokyo', weekStart: 'monday' }, { timezone: 'UTC', weekStart: 'sunday' });
    await expect(fetchConnectionPreferences(client)).resolves.toEqual({ timezone: 'Asia/Tokyo', weekStart: 'monday' });
  });

  it('treats an empty user field as "inherit" rather than letting it shadow the org value', async () => {
    // Grafana's own semantics: a user who hasn't chosen a week-start has `''`
    // there, which means the org's setting applies — not "no week-start".
    const { client } = stub({ timezone: '', weekStart: '   ' }, { timezone: 'UTC', weekStart: 'monday' });
    await expect(fetchConnectionPreferences(client)).resolves.toEqual({ timezone: 'UTC', weekStart: 'monday' });
  });

  it('uses whichever tier it could read when the other is forbidden', async () => {
    const { client } = stub(new Error('403 Forbidden'), { weekStart: 'monday' });
    await expect(fetchConnectionPreferences(client)).resolves.toEqual({ timezone: undefined, weekStart: 'monday' });
  });

  it('reports nothing rather than failing when neither tier can be read', async () => {
    // A token without org.preferences:read must not turn a working screenshot
    // into an error — the caller falls back to the documented defaults and
    // reports that it did.
    const { client } = stub(new Error('403'), new Error('403'));
    await expect(fetchConnectionPreferences(client)).resolves.toEqual({});
  });

  it('reads each connection at most once', async () => {
    const { client, getUserPreferences, getOrgPreferences } = stub({ weekStart: 'monday' }, {});
    await Promise.all([fetchConnectionPreferences(client), fetchConnectionPreferences(client)]);
    await fetchConnectionPreferences(client);
    expect(getUserPreferences).toHaveBeenCalledTimes(1);
    expect(getOrgPreferences).toHaveBeenCalledTimes(1);
    clearConnectionPreferencesCache(client);
    await fetchConnectionPreferences(client);
    expect(getUserPreferences).toHaveBeenCalledTimes(2);
  });

  it('does not memoize a total failure, so a transient outage does not stick for the process lifetime', async () => {
    const results: Array<PreferencesDto | Error> = [new Error('ECONNRESET'), { weekStart: 'monday' }];
    const getUserPreferences = vi.fn(async () => {
      const next = results.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const client = { getUserPreferences, getOrgPreferences: async () => { throw new Error('403'); } } as unknown as GrafanaClient;
    await expect(fetchConnectionPreferences(client)).resolves.toEqual({});
    await expect(fetchConnectionPreferences(client)).resolves.toEqual({ timezone: undefined, weekStart: 'monday' });
  });
});
