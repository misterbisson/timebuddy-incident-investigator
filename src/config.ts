export interface Config {
  grafanaUrl: string;
  grafanaToken: string;
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

  const grafanaUrl = env.GRAFANA_URL;
  const grafanaToken = env.GRAFANA_TOKEN;
  if (!grafanaUrl) {
    throw new Error('GRAFANA_URL is required (see .env.example)');
  }
  if (!grafanaToken) {
    throw new Error('GRAFANA_TOKEN is required (see .env.example)');
  }

  cached = {
    grafanaUrl: grafanaUrl.replace(/\/+$/, ''),
    grafanaToken,
    tlsVerify: parseBool(env.GRAFANA_TLS_VERIFY, true),
    requestTimeoutMs: parseInt_(env.GRAFANA_REQUEST_TIMEOUT_MS, 15000),
    maxConcurrency: parseInt_(env.GRAFANA_MAX_CONCURRENCY, 4),
    maxLookbackHours: parseInt_(env.MAX_LOOKBACK_HOURS, 720),
    maxDataPoints: parseInt_(env.MAX_DATA_POINTS, 2000),
    redactionPatterns: parseRedactionPatterns(env.REDACTION_PATTERNS),
    dataDir: env.DATA_DIR ?? '.data',
    webhookPort: parseInt_(env.WEBHOOK_PORT, 4318),
  };
  return cached;
}

/** Test-only: clear the memoized config so a fresh loadConfig() re-reads env. */
export function resetConfigForTests(): void {
  cached = undefined;
}
