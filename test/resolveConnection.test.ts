import { describe, expect, it } from 'vitest';
import { resolveConnection, originMatchesConnection } from '../src/connections/resolve.js';
import type { GrafanaConnection } from '../src/config.js';

const prod: GrafanaConnection = { id: 'prod', name: 'prod', url: 'https://grafana.prod.example.com', authType: 'bearer', token: 'x' };
const eu: GrafanaConnection = {
  id: 'eu',
  name: 'eu',
  url: 'https://grafana.eu.example.com',
  authType: 'bearer',
  token: 'y',
  matchHosts: ['grafana-eu-alt.example.com'],
};

describe('resolveConnection', () => {
  it('throws when no connections are configured', () => {
    expect(() => resolveConnection({}, [])).toThrow(/No Grafana connections configured/);
  });

  it('an explicit id always wins, even with a hintUrl pointing elsewhere', () => {
    const { connection, matchedBy } = resolveConnection(
      { explicitId: 'eu', hintUrl: 'https://grafana.prod.example.com/d/abc' },
      [prod, eu],
    );
    expect(connection.id).toBe('eu');
    expect(matchedBy).toBe('explicit');
  });

  it('throws on an unknown explicit id, listing what is available', () => {
    expect(() => resolveConnection({ explicitId: 'bogus' }, [prod, eu])).toThrow(/Unknown connection id "bogus"/);
  });

  it('matches a hintUrl by connection url hostname', () => {
    const { connection, matchedBy } = resolveConnection({ hintUrl: 'https://grafana.prod.example.com/d/abc' }, [prod, eu]);
    expect(connection.id).toBe('prod');
    expect(matchedBy).toBe('host');
  });

  it('matches a hintUrl via matchHosts when the primary url differs', () => {
    const { connection } = resolveConnection({ hintUrl: 'https://grafana-eu-alt.example.com/d/abc' }, [prod, eu]);
    expect(connection.id).toBe('eu');
  });

  it('falls back to the single configured connection when there is no hint', () => {
    const { connection, matchedBy } = resolveConnection({}, [prod]);
    expect(connection.id).toBe('prod');
    expect(matchedBy).toBe('single');
  });

  it('throws when there is no hint and multiple connections are configured', () => {
    expect(() => resolveConnection({}, [prod, eu])).toThrow(/Could not determine which Grafana connection/);
  });

  it('throws when a hintUrl matches multiple connections', () => {
    const dup: GrafanaConnection = { ...eu, id: 'eu2', matchHosts: [] , url: prod.url };
    expect(() => resolveConnection({ hintUrl: 'https://grafana.prod.example.com/d/abc' }, [prod, dup])).toThrow(
      /matches multiple connections/,
    );
  });

  // The single-connection setup is the common one, and it was the one that
  // guessed: an alert from another region resolved to the only connection and
  // the investigation silently ran against the wrong Grafana.
  it('throws rather than falling back to the sole connection when a hintUrl matches nothing', () => {
    expect(() => resolveConnection({ hintUrl: 'https://grafana.eu.example.com/d/abc' }, [prod])).toThrow(
      /does not match any configured connection/,
    );
  });

  it('names the unmatched host, the available connections, and matchHosts as the fix', () => {
    try {
      resolveConnection({ hintUrl: 'https://grafana.eu.example.com/d/abc' }, [prod]);
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('grafana.eu.example.com');
      expect(message).toContain('prod (https://grafana.prod.example.com)');
      expect(message).toContain('matchHosts');
    }
  });

  it('still errors on an unmatched hint when several connections are configured', () => {
    expect(() => resolveConnection({ hintUrl: 'https://grafana.apac.example.com/d/abc' }, [prod, eu])).toThrow(
      /does not match any configured connection/,
    );
  });

  // A hint with no parseable hostname carries nothing that could contradict the
  // fallback, so it stays a fallback rather than becoming an error.
  it('falls back to the single connection when the hintUrl has no parseable host', () => {
    const { connection, matchedBy } = resolveConnection({ hintUrl: 'not a url' }, [prod]);
    expect(connection.id).toBe('prod');
    expect(matchedBy).toBe('single');
  });
});

// The Electron live-view <webview>'s auth guard picks a connection per request
// ORIGIN (scheme+host+port), not per tool-call hostname — so matchHosts must be
// honored, but only under the connection's own scheme, or the alias support
// re-opens the plaintext token leak #69/#81 closed. These pin that contract.
describe('originMatchesConnection', () => {
  it("matches a connection's own origin exactly", () => {
    expect(originMatchesConnection('https://grafana.prod.example.com', prod)).toBe(true);
  });

  it('matches a matchHosts alias under the connection\'s own scheme', () => {
    expect(originMatchesConnection('https://grafana-eu-alt.example.com', eu)).toBe(true);
  });

  // The whole reason this isn't a bare host match: an https connection's bearer
  // token must never be injected into a plaintext http:// request to the alias.
  it('does NOT match a matchHosts alias over a different (plaintext) scheme', () => {
    expect(originMatchesConnection('http://grafana-eu-alt.example.com', eu)).toBe(false);
  });

  it('does not match a host that is neither the url nor an alias', () => {
    expect(originMatchesConnection('https://grafana.apac.example.com', eu)).toBe(false);
  });

  it('has no aliases to match when matchHosts is unset', () => {
    expect(originMatchesConnection('https://anything.example.com', prod)).toBe(false);
    expect(originMatchesConnection('https://grafana.prod.example.com', prod)).toBe(true);
  });

  it('lowercases alias entries so an origin (always lowercased) still matches', () => {
    const mixed: GrafanaConnection = { ...eu, matchHosts: ['Grafana-EU-Alt.Example.COM'] };
    expect(originMatchesConnection('https://grafana-eu-alt.example.com', mixed)).toBe(true);
  });

  // matchHosts entries are bare hostnames with no port, so an alias resolves to
  // its scheme's default-port origin only. A non-default-port origin is not
  // matched (that case wants full origins in matchHosts — deferred, see #85).
  it('matches an own-url origin on a non-default port exactly, and only there', () => {
    const ported: GrafanaConnection = { ...prod, url: 'https://grafana.prod.example.com:8443' };
    expect(originMatchesConnection('https://grafana.prod.example.com:8443', ported)).toBe(true);
    expect(originMatchesConnection('https://grafana.prod.example.com', ported)).toBe(false);
  });

  it('does not match an alias on a non-default port', () => {
    expect(originMatchesConnection('https://grafana-eu-alt.example.com:8443', eu)).toBe(false);
  });

  it('matches nothing when the connection url does not parse', () => {
    const broken: GrafanaConnection = { ...prod, url: 'not a url', matchHosts: ['grafana-alias.example.com'] };
    expect(originMatchesConnection('https://grafana-alias.example.com', broken)).toBe(false);
  });
});
