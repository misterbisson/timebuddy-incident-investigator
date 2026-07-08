export interface GraylogSearchUrlOptions {
  fromMs?: number;
  toMs?: number;
  streamId?: string;
}

/**
 * Builds a clickable Graylog search URL so a human reading a tool result can
 * jump straight to it, at the right query and absolute time range, instead of
 * reconstructing one by hand — same rationale as grafana/urlBuilder.ts's
 * buildDashboardUrl. Stream-scoped searches use Graylog's /streams/:id/search
 * path; an unscoped search uses /search directly.
 */
export function buildGraylogSearchUrl(baseUrl: string, query: string, opts: GraylogSearchUrlOptions = {}): string {
  const path = opts.streamId ? `/streams/${encodeURIComponent(opts.streamId)}/search` : '/search';
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`);
  url.searchParams.set('q', query);
  if (opts.fromMs !== undefined && opts.toMs !== undefined) {
    url.searchParams.set('rangetype', 'absolute');
    url.searchParams.set('from', new Date(opts.fromMs).toISOString());
    url.searchParams.set('to', new Date(opts.toMs).toISOString());
  }
  return url.toString();
}
