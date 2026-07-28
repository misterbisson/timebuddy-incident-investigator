import type { Config, GrafanaConnection } from '../config.js';
import type {
  AlertmanagerAlert,
  DashboardGetResponse,
  DatasourceInfo,
  DsQueryRequest,
  DsQueryResponse,
  FolderInfo,
  GrafanaAnnotation,
  LabelValuesResponse,
  RulerAlertRule,
  RulerRuleGroup,
  SearchResultItem,
  ShortUrlInfo,
} from './types.js';
import { Semaphore } from '../util/semaphore.js';

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
  private dispatcherPromise?: Promise<unknown>;

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

  private getDispatcher(): Promise<unknown> | undefined {
    if (this.tlsVerify) return undefined;
    // Memoize the whole import-and-construct as one promise, assigned
    // synchronously. The previous version awaited import('undici') *between*
    // the "already built?" guard and the assignment, so under the semaphore's
    // allowed concurrency several first requests all passed the guard, each
    // constructed its own Agent, and all but the last were orphaned — an
    // undici connection-pool leak (issue #154). Sharing one promise means one
    // Agent, and concurrent callers all await the same construction. Only
    // reached when TLS verification is explicitly disabled for a trusted
    // internal instance (GRAFANA_TLS_VERIFY=false / a per-connection override).
    // On failure the slot is cleared so a later call can retry rather than
    // caching a rejected promise forever.
    this.dispatcherPromise ??= import('undici')
      .then(({ Agent }) => new Agent({ connect: { rejectUnauthorized: false } }))
      .catch((err) => {
        this.dispatcherPromise = undefined;
        throw err;
      });
    return this.dispatcherPromise;
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
    /**
     * 1-indexed page. Grafana's /api/search caps a single response at 5000
     * rows regardless of `limit`, so a full-estate crawl has to page through
     * (see buildMetricIndex); without this it silently sees only the first
     * page and reports a partial index as if it were complete.
     */
    page?: number;
  } = {}): Promise<SearchResultItem[]> {
    const qs = new URLSearchParams();
    qs.set('type', 'dash-db');
    if (params.query) qs.set('query', params.query);
    if (params.folderUid) qs.set('folderUIDs', params.folderUid);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.page) qs.set('page', String(params.page));
    for (const t of params.tag ?? []) qs.append('tag', t);
    return this.request<SearchResultItem[]>('GET', `/api/search?${qs.toString()}`);
  }

  /**
   * Same `/api/search` endpoint as searchDashboards, scoped to `type=dash-folder`
   * instead — lists the subfolders directly inside `folderUid` (or every
   * folder, when omitted; see searchDashboards' folderUid doc for the same
   * "no folderUid means the whole estate, not just the root" caveat). Used by
   * list_folder_dashboards to walk a folder's subfolder tree.
   */
  async searchFolders(params: { folderUid?: string; limit?: number; page?: number } = {}): Promise<SearchResultItem[]> {
    const qs = new URLSearchParams();
    qs.set('type', 'dash-folder');
    if (params.folderUid) qs.set('folderUIDs', params.folderUid);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.page) qs.set('page', String(params.page));
    return this.request<SearchResultItem[]>('GET', `/api/search?${qs.toString()}`);
  }

  async getDashboard(uid: string): Promise<DashboardGetResponse> {
    return this.request<DashboardGetResponse>('GET', `/api/dashboards/uid/${encodeURIComponent(uid)}`);
  }

  /** Used to walk a folder's ancestor chain (Grafana has no single "chain" endpoint) when looking up a knowledge dashboard scoped to a parent folder. */
  async getFolder(uid: string): Promise<FolderInfo> {
    return this.request<FolderInfo>('GET', `/api/folders/${encodeURIComponent(uid)}`);
  }

  /**
   * Resolves a Grafana share short-link's id (the `<uid>` in `/goto/<uid>`,
   * produced by "Share -> Link -> Shorten URL") to the canonical relative path
   * it stands for, via Grafana's short-URL API — the same lookup Grafana's own
   * frontend performs when a `/goto/` link is opened, rather than following
   * the `/goto/` redirect itself (which isn't under `/api` and isn't part of
   * this client's JSON request() helper). Throws GrafanaApiError with
   * status 404 for an unknown/expired uid (Grafana prunes short URLs
   * server-side over time) — callers use that to distinguish a dead link from
   * an unrecognized URL shape.
   */
  async resolveShortUrl(uid: string): Promise<ShortUrlInfo> {
    return this.request<ShortUrlInfo>('GET', `/api/short-urls/${encodeURIComponent(uid)}`);
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

  /**
   * Enumerates a Prometheus label's values, optionally scoped to one metric
   * (`match`), via Grafana's read-only datasource "resources" proxy — the same
   * endpoint Grafana's own `label_values(metric, label)` template variable
   * uses. This is a fixed path to exactly the label-values resource, not a
   * generic resources proxy, so the read-only allowlist stays real (see the
   * class doc): a caller can read a label's values and nothing else.
   */
  async getPrometheusLabelValues(uid: string, label: string, match?: string): Promise<string[]> {
    const qs = new URLSearchParams();
    if (match) qs.append('match[]', match);
    const query = qs.toString();
    const path = `/api/datasources/uid/${encodeURIComponent(uid)}/resources/api/v1/label/${encodeURIComponent(label)}/values${query ? `?${query}` : ''}`;
    return this.parseLabelValues(await this.request<LabelValuesResponse>('GET', path), path);
  }

  /**
   * Loki counterpart of getPrometheusLabelValues, scoped by an optional stream
   * selector (`selector`). Same fixed-path, read-only rationale.
   */
  async getLokiLabelValues(uid: string, label: string, selector?: string): Promise<string[]> {
    const qs = new URLSearchParams();
    if (selector) qs.set('query', selector);
    const query = qs.toString();
    const path = `/api/datasources/uid/${encodeURIComponent(uid)}/resources/loki/api/v1/label/${encodeURIComponent(label)}/values${query ? `?${query}` : ''}`;
    return this.parseLabelValues(await this.request<LabelValuesResponse>('GET', path), path);
  }

  private parseLabelValues(response: LabelValuesResponse, path: string): string[] {
    // The proxy passes the datasource's native body through with HTTP 200 even
    // for a datasource-level error, so a non-"success" status has to be caught
    // here rather than by request()'s !response.ok check.
    if (response.status && response.status !== 'success') {
      throw new Error(`Label-values query failed (${path}): status "${response.status}"${response.error ? `: ${response.error}` : ''}`);
    }
    // A valid label-values envelope always carries a data array (empty is
    // fine). A 200 body without one isn't the label API's response at all —
    // a Grafana error wrapper, or an unexpected datasource version — so
    // surface it rather than silently reading a malformed body as "no values".
    if (!Array.isArray(response.data)) {
      throw new Error(`Unexpected label-values response (${path}): no "data" array${response.error ? ` (${response.error})` : ''}`);
    }
    return response.data.filter((v): v is string => typeof v === 'string');
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
