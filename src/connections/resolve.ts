import type { GrafanaConnection } from '../config.js';

export interface ResolveConnectionInput {
  explicitId?: string;
  hintUrl?: string;
}

export interface ResolvedConnection {
  connection: GrafanaConnection;
  matchedBy: 'explicit' | 'host' | 'single';
}

function safeHostname(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Whether a bare hostname belongs to a connection: its own URL host, or any of
 * its configured `matchHosts` aliases. Host-level and scheme-agnostic on
 * purpose — this maps an alert/dashboard link's hostname to a connection so the
 * engine can then issue its own request against that connection's own `url`, so
 * the alias never dictates the scheme the token goes out over.
 *
 * This is intentionally NOT the check the Electron live-view auth guard uses:
 * that one injects a connection's Authorization header into a browser session's
 * requests, so it must pin the scheme (see originMatchesConnection). The two
 * live side by side here so the alias set they consult can't drift apart the
 * way it did when the live-view guard ignored `matchHosts` entirely (#85).
 */
export function hostMatchesConnection(host: string, connection: GrafanaConnection): boolean {
  const h = host.toLowerCase();
  if (safeHostname(connection.url) === h) return true;
  return (connection.matchHosts ?? []).some((entry) => entry.toLowerCase() === h);
}

/**
 * Whether a request ORIGIN ("https://host[:port]") should be authenticated as
 * this connection. Used by the Electron Activity window's long-lived live-view
 * `<webview>` session, which injects a connection's Authorization header per
 * request and so must decide which connection (if any) an arbitrary request
 * origin belongs to.
 *
 * The connection's own origin always matches (exact scheme+host+port). A
 * `matchHosts` alias matches too — but ONLY under the connection's own scheme,
 * at that scheme's default port. That scheme pin is the security-relevant part:
 * matching an alias on host alone would re-open the exact leak #69/#81 closed,
 * where an https connection's bearer token is transmitted over plaintext
 * http:// to the same hostname and read straight off the wire. An alias on a
 * non-default port is deliberately not matched — `matchHosts` entries are bare
 * hostnames with no port, and a deployment that needs a non-default-port alias
 * wants full origins in `matchHosts`, which is tracked separately, not inferred
 * here. A connection whose own `url` doesn't parse matches nothing.
 */
export function originMatchesConnection(origin: string, connection: GrafanaConnection): boolean {
  let connUrl: URL;
  try {
    connUrl = new URL(connection.url);
  } catch {
    return false;
  }
  if (connUrl.origin === origin) return true;
  // Each matchHosts entry is a bare hostname; build its origin under the
  // connection's own scheme (protocol carries its trailing colon, so this is
  // e.g. "https://grafana-alias.example.com", normalizing to that scheme's
  // default-port origin). Require the parsed hostname to equal the entry, so an
  // entry that smuggles in userinfo, a path, or a port ("admin@evil.com",
  // "evil.com/x", "evil.com:80") is rejected here exactly as
  // hostMatchesConnection's string compare rejects it, rather than silently
  // resolving to some other host — that keeps the two matchers' alias set the
  // same, which is the whole reason they sit together.
  return (connection.matchHosts ?? []).some((entry) => {
    const host = entry.toLowerCase();
    try {
      const aliasUrl = new URL(`${connUrl.protocol}//${entry}`);
      return aliasUrl.hostname === host && aliasUrl.origin === origin;
    } catch {
      return false;
    }
  });
}

function describeAvailable(connections: GrafanaConnection[]): string {
  return connections.map((c) => `${c.id} (${c.url})`).join(', ');
}

/**
 * Picks which Grafana connection a tool call should use: an explicit id
 * always wins; otherwise infer from the alert/dashboard link's hostname;
 * otherwise fall back to the only configured connection. Ambiguous or
 * unresolvable is a hard error — guessing which Grafana to hit is the wrong
 * failure mode for a read-only investigation tool.
 *
 * The single-connection fallback applies only when nothing contradicted it: a
 * hint URL naming a host that matches no connection is unresolvable and errors,
 * even when there's exactly one connection to fall back to.
 */
export function resolveConnection(
  input: ResolveConnectionInput,
  connections: GrafanaConnection[],
): ResolvedConnection {
  if (connections.length === 0) {
    throw new Error(
      'No Grafana connections configured. Set GRAFANA_URL/GRAFANA_TOKEN, or add connections in the ' +
        'connection manager app (see README).',
    );
  }

  if (input.explicitId) {
    const found = connections.find((c) => c.id === input.explicitId);
    if (!found) {
      throw new Error(
        `Unknown connection id "${input.explicitId}". Available: ${describeAvailable(connections)}`,
      );
    }
    return { connection: found, matchedBy: 'explicit' };
  }

  if (input.hintUrl) {
    const host = safeHostname(input.hintUrl);
    const matches = host ? connections.filter((c) => hostMatchesConnection(host, c)) : [];
    if (matches.length === 1) return { connection: matches[0]!, matchedBy: 'host' };
    if (matches.length > 1) {
      throw new Error(
        `Alert host "${host}" matches multiple connections (${matches.map((c) => c.id).join(', ')}); ` +
          'pass an explicit connection id.',
      );
    }
    // A hint that names a real host and matches nothing is unresolvable, not
    // absent — so it must not fall through to the single-connection fallback
    // below. Doing so pointed an alert from one region's Grafana at another's:
    // either a baffling "dashboard not found" for a dashboard the user is
    // looking at, or, on a provisioned estate where the same uid exists in both,
    // a whole investigation run against the wrong region's data with nothing
    // saying so. An unparseable hint carries no host to contradict anything, so
    // that case still falls through.
    if (host) {
      throw new Error(
        `Alert host "${host}" does not match any configured connection. Available: ${describeAvailable(connections)}. ` +
          'Pass "connection" explicitly, or add the host to that connection\'s matchHosts if it\'s an alias for one of these.',
      );
    }
  }

  if (connections.length === 1) {
    return { connection: connections[0]!, matchedBy: 'single' };
  }

  throw new Error(
    `Could not determine which Grafana connection to use. Available: ${describeAvailable(connections)}. ` +
      'Pass "connection" explicitly.',
  );
}
