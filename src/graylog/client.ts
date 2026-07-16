import type { Config, LogConnection } from '../config.js';
import type { GraylogSearchResponse, GraylogStream, GraylogStreamsResponse } from './types.js';

/** A tiny counting semaphore used to cap concurrent outgoing Graylog requests. Same shape as GrafanaClient's — kept as a separate copy rather than a shared import so each client's concurrency limit is independent. */
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
 * Builds the Authorization header value for a log connection. Graylog's REST
 * API doesn't accept a real `Authorization: Bearer` header for API-token
 * auth — its documented convention is HTTP Basic with the token as the
 * username and the literal string "token" as the password (confirmed
 * against github.com/lcaliani/graylog-mcp's implementation). 'basic' is a
 * real username/password login, sent as ordinary HTTP Basic auth.
 */
export function buildGraylogAuthHeader(connection: LogConnection): string {
  if (connection.authType === 'basic') {
    if (!connection.username || !connection.password) {
      throw new Error(`Log connection "${connection.id}" is authType=basic but missing username/password`);
    }
    return `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString('base64')}`;
  }
  if (!connection.token) {
    throw new Error(`Log connection "${connection.id}" is authType=token but missing token`);
  }
  return `Basic ${Buffer.from(`${connection.token}:token`).toString('base64')}`;
}

export class GraylogApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'GraylogApiError';
  }
}

/**
 * Read-only Graylog HTTP client, closed allowlist like GrafanaClient: exactly
 * the two read-only endpoints this server needs (absolute-range search,
 * stream listing) and nothing else — no generic proxy method. Only the
 * legacy (2.x-5.x) Universal Search API is implemented; Graylog 6.x's Views
 * API returns CSV and needs materially different parsing, deferred (see
 * README's "Known limitations").
 */
export class GraylogClient {
  private readonly semaphore: Semaphore;
  private tlsAgent: unknown;

  constructor(
    private readonly connection: LogConnection,
    private readonly config: Config,
  ) {
    this.semaphore = new Semaphore(config.maxConcurrency);
  }

  private get tlsVerify(): boolean {
    return this.connection.tlsVerify ?? this.config.tlsVerify;
  }

  private authHeader(): string {
    return buildGraylogAuthHeader(this.connection);
  }

  private async getDispatcher(): Promise<unknown> {
    if (this.tlsVerify) return undefined;
    if (this.tlsAgent) return this.tlsAgent;
    const { Agent } = await import('undici');
    this.tlsAgent = new Agent({ connect: { rejectUnauthorized: false } });
    return this.tlsAgent;
  }

  private async request<T>(path: string): Promise<T> {
    return this.semaphore.run(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const dispatcher = await this.getDispatcher();
        const response = await fetch(`${this.connection.url}${path}`, {
          method: 'GET',
          headers: {
            Authorization: this.authHeader(),
            Accept: 'application/json',
          },
          signal: controller.signal,
          // Node's undici fetch accepts `dispatcher`; not in the lib.dom fetch types.
          ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new GraylogApiError(
            `Graylog GET ${path} failed: ${response.status} ${text.slice(0, 500)}`,
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

  /**
   * One bounded, historical search — Graylog's absolute-range endpoint takes
   * explicit ISO8601 from/to, unlike the log-correlator package's own
   * adapters (which only ever query relative-to-now). This is what makes a
   * fixed, possibly days-old incident window work at all (see
   * src/logs/adapter.ts).
   */
  async searchAbsolute(params: {
    query: string;
    fromMs: number;
    toMs: number;
    streamId?: string;
    limit?: number;
  }): Promise<GraylogSearchResponse> {
    const qs = new URLSearchParams({
      query: params.query,
      from: new Date(params.fromMs).toISOString(),
      to: new Date(params.toMs).toISOString(),
      limit: String(params.limit ?? 500),
      sort: 'timestamp:asc',
      // "*" requests every indexed field, not just the fixed ones — needed so
      // correlate_logs can join on arbitrary fields (request_id, trace_id, ...).
      fields: '_id,message,timestamp,source,*',
    });
    const streamId = params.streamId ?? this.connection.streamId;
    if (streamId) qs.set('filter', `streams:${streamId}`);
    return this.request<GraylogSearchResponse>(`/api/search/universal/absolute?${qs.toString()}`);
  }

  async listStreams(): Promise<GraylogStream[]> {
    const response = await this.request<GraylogStreamsResponse>('/api/streams');
    return response.streams;
  }
}
