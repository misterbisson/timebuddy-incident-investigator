/**
 * Builds a clickable Graylog search URL — the log-side counterpart to
 * grafana/urlBuilder.ts's buildDashboardUrl — so a human reading a tool
 * result can jump straight to the same search in Graylog's own UI. Scoped to
 * one stream (`/streams/:id/search`) when a streamId is known, otherwise the
 * global search. Always an absolute-range search, matching what
 * GraylogClient.searchAbsolute() actually queried.
 */
export function buildGraylogSearchUrl(
  baseUrl: string,
  params: { query: string; fromMs: number; toMs: number; streamId?: string },
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const path = params.streamId ? `/streams/${encodeURIComponent(params.streamId)}/search` : '/search';
  const url = new URL(`${base}${path}`);
  url.searchParams.set('q', params.query);
  url.searchParams.set('rangetype', 'absolute');
  url.searchParams.set('from', new Date(params.fromMs).toISOString());
  url.searchParams.set('to', new Date(params.toMs).toISOString());
  return url.toString();
}
