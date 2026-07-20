import { describe, expect, it } from 'vitest';
import { resolveConnection } from '../src/connections/resolve.js';
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
