export interface GrafanaConnection {
  id: string;
  name: string;
  url: string;
  authType: 'bearer' | 'basic';
  token?: string;
  username?: string;
  password?: string;
  /** Extra hostnames that should also resolve to this connection (e.g. a LB/VPN alias the alert link uses). */
  matchHosts?: string[];
  /** Per-connection override of the global tlsVerify default. */
  tlsVerify?: boolean;
}

export interface Config {
  connections: GrafanaConnection[];
  /** Directory the connection-manager app writes connections.json/credentials.json into. */
  connectionsDir: string;
  tlsVerify: boolean;
  requestTimeoutMs: number;
  maxConcurrency: number;
  maxLookbackHours: number;
  maxDataPoints: number;
  redactionPatterns: RegExp[];
  dataDir: string;
  webhookPort: number;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

function parseInt_(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseRedactionPatterns(value: string | undefined): RegExp[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new RegExp(s, 'i'));
}

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  const dataDir = env.DATA_DIR ?? '.data';

  // GRAFANA_URL/GRAFANA_TOKEN remain a supported single-connection convenience
  // path (CI, tests, or anyone who doesn't need multiple endpoints) alongside
  // whatever the connection-manager app has written to disk — see
  // src/connections/store.ts, merged in by src/index.ts at startup.
  const envConnections: GrafanaConnection[] = [];
  if (env.GRAFANA_URL && env.GRAFANA_TOKEN) {
    envConnections.push({
      id: 'env-default',
      name: 'env-default',
      url: env.GRAFANA_URL.replace(/\/+$/, ''),
      authType: 'bearer',
      token: env.GRAFANA_TOKEN,
    });
  }

  cached = {
    connections: envConnections,
    connectionsDir: env.GRAFANA_CONNECTIONS_DIR ?? `${dataDir}/connections`,
    tlsVerify: parseBool(env.GRAFANA_TLS_VERIFY, true),
    requestTimeoutMs: parseInt_(env.GRAFANA_REQUEST_TIMEOUT_MS, 15000),
    maxConcurrency: parseInt_(env.GRAFANA_MAX_CONCURRENCY, 4),
    maxLookbackHours: parseInt_(env.MAX_LOOKBACK_HOURS, 720),
    maxDataPoints: parseInt_(env.MAX_DATA_POINTS, 2000),
    redactionPatterns: parseRedactionPatterns(env.REDACTION_PATTERNS),
    dataDir,
    webhookPort: parseInt_(env.WEBHOOK_PORT, 4318),
  };
  return cached;
}

/** Test-only: clear the memoized config so a fresh loadConfig() re-reads env. */
export function resetConfigForTests(): void {
  cached = undefined;
}
