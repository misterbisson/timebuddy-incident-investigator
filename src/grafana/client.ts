import type { Config, GrafanaConnection } from '../config.js';
import type {
  AlertmanagerAlert,
  DashboardGetResponse,
  DatasourceInfo,
  DsQueryRequest,
  DsQueryResponse,
  GrafanaAnnotation,
  RulerAlertRule,
  RulerRuleGroup,
  SearchResultItem,
} from './types.js';

/** A tiny counting semaphore used to cap concurrent outgoing Grafana requests. */
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

/**
 * Builds the Authorization header value for a connection. Exported so
 * callers outside GrafanaClient's own fetch() calls (screenshot_panel's
 * headless-browser capture, which needs the identical header applied to a
 * real browser's outgoing requests) can authenticate exactly the same way,
 * without duplicating the bearer/basic branching.
 */
export function buildAuthHeader(connection: GrafanaConnection): string {
  if (connection.authType === 'basic') {
    if (!connection.username || !connection.password) {
      throw new Error(`Connection "${connection.id}" is authType=basic but missing username/password`);
    }
    return `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString('base64')}`;
  }
  if (!connection.token) {
    throw new Error(`Connection "${connection.id}" is authType=bearer but missing token`);
  }
  return `Bearer ${connection.token}`;
}

export class GrafanaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'GrafanaApiError';
  }
}

/**
 * Read-only Grafana HTTP client. This is a deliberate allowlist: it exposes
 * exactly the endpoints this server needs and nothing else. There is no
 * "make an arbitrary request" escape hatch, so no tool built on top of this
 * client can ever mutate Grafana state or reach an unreviewed endpoint.
 */
export class GrafanaClient {
  private readonly semaphore: Semaphore;
  private tlsAgent: unknown;

  constructor(
    private readonly connection: GrafanaConnection,
    private readonly config: Config,
  ) {
    this.semaphore = new Semaphore(config.maxConcurrency);
  }

  private get tlsVerify(): boolean {
    return this.connection.tlsVerify ?? this.config.tlsVerify;
  }

  private authHeader(): string {
    return buildAuthHeader(this.connection);
  }

  private async getDispatcher(): Promise<unknown> {
    if (this.tlsVerify) return undefined;
    if (this.tlsAgent) return this.tlsAgent;
    // Only imported when explicitly opted out of TLS verification for a
    // trusted internal instance (GRAFANA_TLS_VERIFY=false / a connection's
    // per-instance tlsVerify override).
    const { Agent } = await import('undici');
    this.tlsAgent = new Agent({ connect: { rejectUnauthorized: false } });
    return this.tlsAgent;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.semaphore.run(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const dispatcher = await this.getDispatcher();
        const response = await fetch(`${this.connection.url}${path}`, {
          method,
          headers: {
            Authorization: this.authHeader(),
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          // Node's undici fetch accepts `dispatcher`; not in the lib.dom fetch types.
          ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new GrafanaApiError(
            `Grafana ${method} ${path} failed: ${response.status} ${text.slice(0, 500)}`,
            response.status,
            path,
          );
        }
        return (await response.json()) as T;
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  async searchDashboards(params: {
    query?: string;
    tag?: string[];
    folderUid?: string;
    limit?: number;
  } = {}): Promise<SearchResultItem[]> {
    const qs = new URLSearchParams();
    qs.set('type', 'dash-db');
    if (params.query) qs.set('query', params.query);
    if (params.folderUid) qs.set('folderUIDs', params.folderUid);
    if (params.limit) qs.set('limit', String(params.limit));
    for (const t of params.tag ?? []) qs.append('tag', t);
    return this.request<SearchResultItem[]>('GET', `/api/search?${qs.toString()}`);
  }

  async getDashboard(uid: string): Promise<DashboardGetResponse> {
    return this.request<DashboardGetResponse>('GET', `/api/dashboards/uid/${encodeURIComponent(uid)}`);
  }

  async listDatasources(): Promise<DatasourceInfo[]> {
    return this.request<DatasourceInfo[]>('GET', '/api/datasources');
  }

  async getDatasource(uid: string): Promise<DatasourceInfo> {
    return this.request<DatasourceInfo>('GET', `/api/datasources/uid/${encodeURIComponent(uid)}`);
  }

  /** Executes queries through Grafana's unified data-query endpoint (read-only). */
  async queryDs(req: DsQueryRequest): Promise<DsQueryResponse> {
    return this.request<DsQueryResponse>('POST', '/api/ds/query', req);
  }

  async getFiringAlerts(): Promise<AlertmanagerAlert[]> {
    return this.request<AlertmanagerAlert[]>('GET', '/api/alertmanager/grafana/api/v2/alerts');
  }

  /** All Grafana-managed alert rule groups, keyed by folder in the raw API response. */
  async getRuleGroups(): Promise<Record<string, RulerRuleGroup[]>> {
    return this.request<Record<string, RulerRuleGroup[]>>('GET', '/api/ruler/grafana/api/v1/rules');
  }

  async getAlertRuleByUid(uid: string): Promise<RulerAlertRule> {
    return this.request<RulerAlertRule>('GET', `/api/v1/provisioning/alert-rules/${encodeURIComponent(uid)}`);
  }

  async getAnnotations(params: {
    dashboardUID?: string;
    panelId?: number;
    from?: number;
    to?: number;
    limit?: number;
  } = {}): Promise<GrafanaAnnotation[]> {
    const qs = new URLSearchParams();
    if (params.dashboardUID) qs.set('dashboardUID', params.dashboardUID);
    if (params.panelId !== undefined) qs.set('panelId', String(params.panelId));
    if (params.from !== undefined) qs.set('from', String(params.from));
    if (params.to !== undefined) qs.set('to', String(params.to));
    qs.set('limit', String(params.limit ?? 100));
    return this.request<GrafanaAnnotation[]>('GET', `/api/annotations?${qs.toString()}`);
  }
}
