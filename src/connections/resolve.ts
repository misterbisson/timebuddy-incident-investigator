export interface ResolveConnectionInput {
  explicitId?: string;
  hintUrl?: string;
}

/**
 * The subset of GrafanaConnection/LogConnection this resolution logic
 * actually needs — kept generic so both share one implementation instead of
 * duplicating "explicit id wins, else the sole connection, else error".
 */
export interface ResolvableConnection {
  id: string;
  url: string;
  matchHosts?: string[];
}

export interface ResolvedConnection<T extends ResolvableConnection> {
  connection: T;
  matchedBy: 'explicit' | 'host' | 'single';
}

function safeHostname(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostMatches(host: string, connection: ResolvableConnection): boolean {
  const connectionHost = safeHostname(connection.url);
  if (connectionHost === host) return true;
  return (connection.matchHosts ?? []).some((h) => h.toLowerCase() === host);
}

function describeAvailable(connections: ResolvableConnection[]): string {
  return connections.map((c) => `${c.id} (${c.url})`).join(', ');
}

/**
 * Picks which connection a tool call should use: an explicit id always wins;
 * otherwise infer from the alert/dashboard link's hostname (Grafana
 * connections only in practice — log connections have no comparable
 * inbound link, so callers simply omit hintUrl for those); otherwise fall
 * back to the only configured connection. Ambiguous or unresolvable is a
 * hard error — guessing which connection to hit is the wrong failure mode
 * for a read-only investigation tool.
 *
 * The single-connection fallback applies only when nothing contradicted it: a
 * hint URL naming a host that matches no connection is unresolvable and errors,
 * even when there's exactly one connection to fall back to.
 *
 * Generic over GrafanaConnection/LogConnection so both connection kinds
 * share this logic; `kind` only changes the wording of error messages
 * (default "Grafana" so every pre-existing call site's error text is
 * unchanged) and callers resolving a log connection pass kind="Graylog".
 */
export function resolveConnection<T extends ResolvableConnection>(
  input: ResolveConnectionInput,
  connections: T[],
  kind = 'Grafana',
): ResolvedConnection<T> {
  if (connections.length === 0) {
    throw new Error(
      `No ${kind} connections configured. Set GRAFANA_URL/GRAFANA_TOKEN (or GRAYLOG_URL/GRAYLOG_TOKEN for log ` +
        'connections), or add connections in the connection manager app (see README).',
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
    const matches = host ? connections.filter((c) => hostMatches(host, c)) : [];
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
    `Could not determine which ${kind} connection to use. Available: ${describeAvailable(connections)}. ` +
      'Pass "connection" explicitly.',
  );
}
