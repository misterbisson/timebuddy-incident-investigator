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
  /** Free-form labels (e.g. "prod", "us-east") shared with a LogConnection so a skill can pair the two without guessing. */
  tags?: string[];
}

/**
 * A log source connection (Graylog only for now). Shaped to sit alongside
 * GrafanaConnection rather than unify with it: the two have almost no fields
 * in common beyond auth, and forcing a shared interface would just push
 * Graylog-only fields (apiVersion, streamId) onto every Grafana connection.
 */
export interface LogConnection {
  id: string;
  name: string;
  sourceType: 'graylog';
  url: string;
  authType: 'bearer' | 'basic';
  token?: string;
  username?: string;
  password?: string;
  /** Graylog search API version. Only 'legacy' (JSON responses) is implemented; v6's Views API returns CSV and is out of scope for now. */
  apiVersion?: 'legacy';
  /** Restrict searches to one stream by id. */
  streamId?: string;
  /** Human-readable stream name, for display only (resolving name -> id is not implemented; pass streamId directly). */
  streamName?: string;
  tlsVerify?: boolean;
  /** Free-form labels shared with a GrafanaConnection so a skill can pair the two without guessing. */
  tags?: string[];
}

export interface Config {
  connections: GrafanaConnection[];
  logConnections: LogConnection[];
  tlsVerify: boolean;
  requestTimeoutMs: number;
  maxConcurrency: number;
  maxLookbackHours: number;
  maxDataPoints: number;
  maxLogLines: number;
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

function parseTags(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const tags = value.split(',').map((s) => s.trim()).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  const dataDir = env.DATA_DIR ?? '.data';

  // GRAFANA_URL/GRAFANA_TOKEN are the standalone-CLI/CI convenience path (see
  // src/index.ts). The distributed app instead supplies connections directly
  // to src/server.ts's startMcpServer() from its own safeStorage-backed
  // store (electron/src/connectionStore.js) — no disk-based merge here.
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

  // Same env-only convenience path as GRAFANA_URL/GRAFANA_TOKEN above, for the
  // standalone CLI/CI — the distributed app supplies log connections directly
  // to src/server.ts's startMcpServer() instead, same as Grafana connections.
  const envLogConnections: LogConnection[] = [];
  if (env.GRAYLOG_URL && (env.GRAYLOG_TOKEN || (env.GRAYLOG_USERNAME && env.GRAYLOG_PASSWORD))) {
    envLogConnections.push({
      id: 'env-default',
      name: 'env-default',
      sourceType: 'graylog',
      url: env.GRAYLOG_URL.replace(/\/+$/, ''),
      authType: env.GRAYLOG_TOKEN ? 'bearer' : 'basic',
      token: env.GRAYLOG_TOKEN,
      username: env.GRAYLOG_USERNAME,
      password: env.GRAYLOG_PASSWORD,
      apiVersion: 'legacy',
      streamId: env.GRAYLOG_STREAM_ID,
      tags: parseTags(env.GRAYLOG_TAGS),
    });
  }

  cached = {
    connections: envConnections,
    logConnections: envLogConnections,
    tlsVerify: parseBool(env.GRAFANA_TLS_VERIFY, true),
    requestTimeoutMs: parseInt_(env.GRAFANA_REQUEST_TIMEOUT_MS, 15000),
    maxConcurrency: parseInt_(env.GRAFANA_MAX_CONCURRENCY, 4),
    maxLookbackHours: parseInt_(env.MAX_LOOKBACK_HOURS, 720),
    maxDataPoints: parseInt_(env.MAX_DATA_POINTS, 2000),
    maxLogLines: parseInt_(env.MAX_LOG_LINES, 500),
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
