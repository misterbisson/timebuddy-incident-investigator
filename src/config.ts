/**
 * Also used as dashboards/variables.ts's computeInterval() fallback so the
 * two point-budget assumptions ("$__interval" baked into query text vs. the
 * maxDataPoints actually sent to /api/ds/query) can't silently drift apart
 * the way they did pre-#53, when computeInterval hardcoded its own default.
 */
export const DEFAULT_MAX_DATA_POINTS = 2000;

/** Default per-stream cap on log lines returned by the Graylog tools. */
export const DEFAULT_MAX_LOG_LINES = 500;

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
 * Graylog-only fields (streamId, streamName) onto every Grafana connection.
 *
 * authType is 'token' | 'basic', not Grafana's 'bearer' | 'basic': Graylog's
 * REST API doesn't accept a real `Authorization: Bearer` header for
 * API-token auth — its documented convention is HTTP Basic with the token as
 * the username and the literal string "token" as the password (see
 * src/graylog/client.ts's authHeader()). 'basic' is a real username/password
 * login, same meaning as Grafana's 'basic'.
 */
export interface LogConnection {
  id: string;
  name: string;
  sourceType: 'graylog';
  url: string;
  authType: 'token' | 'basic';
  token?: string;
  username?: string;
  password?: string;
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
  /**
   * Separate from requestTimeoutMs: a full Grafana page load in a headless
   * browser (JS bundle, auth, the panel's own /api/ds/query fetch, chart
   * render) routinely takes longer than a single JSON API call, especially
   * on a heavy dashboard. Reusing requestTimeoutMs here caused screenshot_panel
   * to fail consistently at ~15s on dashboards that render fine in a real
   * browser, well before the page ever finished loading.
   */
  screenshotTimeoutMs: number;
  maxConcurrency: number;
  maxLookbackHours: number;
  maxDataPoints: number;
  /** Hard cap on messages a single search_logs/correlate_logs call can request, same rationale as maxDataPoints. */
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
      authType: env.GRAYLOG_TOKEN ? 'token' : 'basic',
      token: env.GRAYLOG_TOKEN,
      username: env.GRAYLOG_USERNAME,
      password: env.GRAYLOG_PASSWORD,
      streamId: env.GRAYLOG_STREAM_ID,
      tags: parseTags(env.GRAYLOG_TAGS),
    });
  }

  cached = {
    connections: envConnections,
    logConnections: envLogConnections,
    tlsVerify: parseBool(env.GRAFANA_TLS_VERIFY, true),
    requestTimeoutMs: parseInt_(env.GRAFANA_REQUEST_TIMEOUT_MS, 15000),
    screenshotTimeoutMs: parseInt_(env.GRAFANA_SCREENSHOT_TIMEOUT_MS, 45000),
    maxConcurrency: parseInt_(env.GRAFANA_MAX_CONCURRENCY, 4),
    maxLookbackHours: parseInt_(env.MAX_LOOKBACK_HOURS, 720),
    maxDataPoints: parseInt_(env.MAX_DATA_POINTS, DEFAULT_MAX_DATA_POINTS),
    maxLogLines: parseInt_(env.MAX_LOG_LINES, DEFAULT_MAX_LOG_LINES),
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
