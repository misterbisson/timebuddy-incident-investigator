import type { GrafanaClient } from './client.js';
import type { PreferencesDto } from './types.js';

/**
 * The timezone/week-start a connection's Grafana is configured with — the
 * inputs a relative-time expression needs before `now/d` or `now/w` names a
 * definite instant (see query/dateMath.ts).
 *
 * Read lazily and only when an expression actually needs them: a `now-1h`
 * link resolves identically in every zone, so the overwhelmingly common case
 * pays nothing for this. See tools/renderDashboard.ts's resolveRenderWindow.
 */
export interface ConnectionPreferences {
  /** Raw Grafana values, un-normalized — `''`/`browser` still mean "inherit". */
  timezone?: string;
  weekStart?: string;
}

/**
 * Per-client memo. The registry already caches one GrafanaClient per
 * connection id and rebuilds it when connections change, so keying on the
 * client instance gives per-connection caching that expires exactly when the
 * connection does — without this module having to know about connection ids.
 * A WeakMap so a dropped client's entry is collectable.
 */
const CACHE = new WeakMap<GrafanaClient, Promise<ConnectionPreferences>>();

/**
 * Merges the token's user preferences over the org's, field by field: an empty
 * string is Grafana's own "inherit from the next tier up", so it must not
 * shadow the org value.
 *
 * A failed read is not an error. These endpoints need `org.preferences:read`
 * (and a service-account token may have neither), and preferences only ever
 * *improve* on the documented defaults in dateMath.ts — turning a working
 * screenshot into a hard failure because a token can't read an org preference
 * would trade a stated, reported default for an outage. The caller reports
 * which tier each value came from, so falling back is visible rather than
 * silent.
 */
export async function fetchConnectionPreferences(client: GrafanaClient): Promise<ConnectionPreferences> {
  const cached = CACHE.get(client);
  if (cached) return cached;
  const pending = (async (): Promise<ConnectionPreferences> => {
    // `.then()` off a resolved promise rather than a bare call, so a client
    // that doesn't implement these (an older stub, a partially-mocked one)
    // lands in the same "couldn't read it" path as a 403 instead of throwing
    // synchronously past the catch.
    const read = (fetch: () => Promise<PreferencesDto>): Promise<PreferencesDto | undefined> =>
      Promise.resolve().then(fetch).catch(() => undefined);
    const [user, org] = await Promise.all([
      read(() => client.getUserPreferences()),
      read(() => client.getOrgPreferences()),
    ]);
    if (!user && !org) {
      // Nothing was actually read — don't memoize a transient network failure
      // as "this connection has no preferences" for the life of the process.
      CACHE.delete(client);
      return {};
    }
    const pick = (field: keyof PreferencesDto): string | undefined => {
      const own = user?.[field]?.trim();
      return own ? own : org?.[field]?.trim();
    };
    return { timezone: pick('timezone'), weekStart: pick('weekStart') };
  })();
  CACHE.set(client, pending);
  return pending;
}

/** Test seam: drops the memo so a suite can exercise a fresh lookup against the same stub client. */
export function clearConnectionPreferencesCache(client: GrafanaClient): void {
  CACHE.delete(client);
}
