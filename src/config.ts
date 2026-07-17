/**
 * Also used as dashboards/variables.ts's computeInterval() fallback so the
 * two point-budget assumptions ("$__interval" baked into query text vs. the
 * maxDataPoints actually sent to /api/ds/query) can't silently drift apart
 * the way they did pre-#53, when computeInterval hardcoded its own default.
 */
export const DEFAULT_MAX_DATA_POINTS = 2000;

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

  cached = {
    connections: envConnections,
    tlsVerify: parseBool(env.GRAFANA_TLS_VERIFY, true),
    requestTimeoutMs: parseInt_(env.GRAFANA_REQUEST_TIMEOUT_MS, 15000),
    screenshotTimeoutMs: parseInt_(env.GRAFANA_SCREENSHOT_TIMEOUT_MS, 45000),
    maxConcurrency: parseInt_(env.GRAFANA_MAX_CONCURRENCY, 4),
    maxLookbackHours: parseInt_(env.MAX_LOOKBACK_HOURS, 720),
    maxDataPoints: parseInt_(env.MAX_DATA_POINTS, DEFAULT_MAX_DATA_POINTS),
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
