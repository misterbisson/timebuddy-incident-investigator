import { z } from 'zod';
import type { GrafanaClient } from '../grafana/client.js';
import type { ConnectionRegistry } from '../grafana/registry.js';
import type { DashboardJson, TemplateVariable } from '../grafana/types.js';
import { findPanel, type ResolvedPanel, type ResolvedTarget } from '../dashboards/panelQueries.js';
import { resolveDatasourceVariable, substituteTargetFields } from '../dashboards/variables.js';
import type { QueryWindow } from '../dashboards/variables.js';
import { resolveConnection } from '../connections/resolve.js';
import { buildDashboardUrl, type DashboardUrlOptions } from '../grafana/urlBuilder.js';
import { buildGraylogSearchUrl } from '../graylog/urlBuilder.js';
import type { GraylogClient } from '../graylog/client.js';
import type { LogConnectionRegistry } from '../graylog/registry.js';
import type { ActivityLog } from '../activity/activityLog.js';
import type { Config } from '../config.js';
import { redact } from '../security/redact.js';

/**
 * A time boundary as either a raw epoch-ms number or an ISO 8601 date/time
 * string ("2026-06-08T00:00:00Z", "2026-06-08"). Every investigation needs
 * to express a specific date at some point, and requiring epoch-ms only
 * pushes that date math onto the caller — in practice, onto shell commands
 * (`date`, `python3 -c "import datetime..."`) run just to convert a human
 * date into a number, each one a permission prompt. Accepting both forms
 * here removes the need for that entirely.
 */
export const epochMsSchema = z.union([z.number(), z.string()]).transform((value, ctx) => {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Could not parse "${value}" as a date — use an ISO 8601 date/time (e.g. "2026-06-08T00:00:00Z") or a raw epoch-ms number`,
    });
    return NaN;
  }
  return parsed;
});

/**
 * Resolves which connection a tool call should use (explicit id wins, else
 * the single configured connection, else an error listing what's available)
 * and returns its client. Single-target tools have no host to auto-detect
 * from (a dashboard UID doesn't carry one), so hintUrl is only meaningful
 * from get_alert_context's alert-link resolution.
 */
export function resolveToolClient(
  registry: ConnectionRegistry,
  input: { connection?: string; hintUrl?: string },
): { client: GrafanaClient; connectionId: string } {
  const { connection } = resolveConnection(
    { explicitId: input.connection, hintUrl: input.hintUrl },
    registry.list(),
  );
  return { client: registry.get(connection.id), connectionId: connection.id };
}

/**
 * Builds a clickable dashboard/panel URL for a connection a tool already
 * resolved — so a human reading a result can jump straight to it in Grafana
 * instead of manually reconstructing a link from a bare dashboardUid/panelId.
 * Returns undefined (never throws) if the connection can't be found, since
 * this is always a nice-to-have addition to a result, not something worth
 * failing a whole tool call over.
 */
export function dashboardUrlFor(
  registry: ConnectionRegistry,
  connectionId: string,
  dashboardUid: string,
  opts?: DashboardUrlOptions,
): string | undefined {
  const connection = registry.list().find((c) => c.id === connectionId);
  if (!connection) return undefined;
  return buildDashboardUrl(connection.url, dashboardUid, opts);
}

/**
 * Log-connection counterpart to resolveToolClient — same explicit-id-or-
 * single-fallback resolution, just against LogConnectionRegistry. No
 * hintUrl: a log connection has no comparable inbound alert/dashboard link
 * to infer from, unlike a Grafana connection.
 */
export function resolveLogToolClient(
  registry: LogConnectionRegistry,
  input: { connection?: string },
): { client: GraylogClient; connectionId: string } {
  const { connection } = resolveConnection({ explicitId: input.connection }, registry.list(), 'Graylog');
  return { client: registry.get(connection.id), connectionId: connection.id };
}

/** Log-connection counterpart to dashboardUrlFor — builds a clickable Graylog search URL for a connection a log tool already resolved. */
export function logSearchUrlFor(
  registry: LogConnectionRegistry,
  connectionId: string,
  params: { query: string; fromMs: number; toMs: number; streamId?: string },
): string | undefined {
  const connection = registry.list().find((c) => c.id === connectionId);
  if (!connection) return undefined;
  return buildGraylogSearchUrl(connection.url, { ...params, streamId: params.streamId ?? connection.streamId });
}

/**
 * Records one entry in the Electron app's Activity log (undefined/no-op in
 * the standalone CLI, which has no window to show it in) — called only at
 * the point a tool actually queries a specific panel's data or captures a
 * screenshot, not every place a dashboard/panel URL happens to get built
 * (fetch_dashboard's panel listing, an error-path link, a skipped/
 * non-queryable panel) — those never actually reached Grafana for data, so
 * logging them as "inspected" would be misleading.
 */
export function recordActivity(
  registry: ConnectionRegistry,
  activityLog: ActivityLog | undefined,
  entry: {
    toolName: string;
    connectionId: string;
    dashboardUid: string;
    dashboardTitle?: string;
    panelId?: number;
    panelTitle?: string;
    url?: string;
    screenshotPath?: string;
  },
): void {
  if (!activityLog) return;
  const connectionName = registry.list().find((c) => c.id === entry.connectionId)?.name;
  activityLog.record({ kind: 'panel', ...entry, connectionName });
}

/**
 * Log-tool counterpart to recordActivity — records a search_logs/correlate_logs
 * call in the Activity log so a log-heavy investigation shows up in the Electron
 * window alongside the Grafana panels it queried. Resolves the display name (and
 * default stream name) from the *log* registry, since a log connection lives in
 * LogConnectionRegistry, not the Grafana one recordActivity reads.
 */
export function recordLogActivity(
  logRegistry: LogConnectionRegistry,
  activityLog: ActivityLog | undefined,
  entry: {
    toolName: string;
    connectionId: string;
    query: string;
    streamId?: string;
    resultCount?: number;
    url?: string;
  },
): void {
  if (!activityLog) return;
  const connection = logRegistry.list().find((c) => c.id === entry.connectionId);
  // Only attach a stream *name* when the effective stream is the connection's
  // configured default — that's the only stream we have a name for. An explicit
  // streamId that isn't the default has no name on this side, so leave it to the
  // id (the renderer falls back to showing the id, then "all streams").
  // A search with no explicit streamId still runs against the connection's own
  // default stream (the client falls back to it), so record that as the
  // effective stream — otherwise the window shows "all streams" for a scoped
  // search. The name only comes along when that effective stream is the default.
  const effectiveStreamId = entry.streamId ?? connection?.streamId;
  const streamName =
    effectiveStreamId && effectiveStreamId === connection?.streamId ? connection?.streamName : undefined;
  activityLog.record({ kind: 'log', ...entry, streamId: effectiveStreamId, connectionName: connection?.name, streamName });
}

/**
 * Standard tool error text, with the dashboard/panel URL appended when one
 * could still be built (i.e. the connection/dashboardUid/panelId were
 * already known before whatever failed) — so a query that times out or
 * errors partway through still gives the caller a link to open the panel
 * directly in Grafana, rather than a dead end with nothing to click through
 * to. Omit `url` when nothing was resolved yet (e.g. connection resolution
 * itself failed) — there's nothing truthful to link to in that case.
 */
function toolErrorText(err: unknown, url?: string): string {
  const message = `Error: ${err instanceof Error ? err.message : String(err)}`;
  return url ? `${message}\n\nDashboard/panel: ${url}` : message;
}

/**
 * The whole error response for a tool's catch block, redacted. Every tool
 * returns this rather than assembling `{ content, isError }` itself, for the
 * same reason `security/audit.ts` redacts centrally instead of trusting each
 * caller: redaction is meant to be a hard guarantee, and a guarantee that
 * depends on fourteen call sites each remembering to apply it isn't one.
 *
 * It matters specifically here because `grafana/client.ts` embeds up to 500
 * characters of the raw Grafana response body in `GrafanaApiError`'s message.
 * A datasource rejecting a query echoes the offending query text back — and
 * that text has template variables already substituted in, so it carries
 * exactly the customer identifiers `redactionPatterns` exists to mask.
 * Success paths were redacted from the start; error paths were the gap.
 */
export function toolErrorResult(err: unknown, config: Config, url?: string) {
  return {
    content: [{ type: 'text' as const, text: redact(toolErrorText(err, url), config.redactionPatterns) }],
    isError: true,
  };
}

/**
 * endsAtMs defaults to "now" for a still-firing alert — but for a resolved/
 * historical alert, forgetting to pass it means "now" can be days or weeks
 * after the incident, silently producing a huge window. Since preWindow and
 * every control window inherit the incident's duration (see windows.ts),
 * that one omission balloons every window in the response, not just this
 * one. Callers use this to fail fast, before running any query, rather than
 * attaching it as a warning to a result that already ballooned — a result
 * large enough to get truncated to a file buries a same-payload warning
 * behind exactly the jq/bash detour this server exists to avoid.
 */
export function windowSizeWarning(
  startsAtMs: number,
  endsAtMsProvided: number | undefined,
  resolvedEndsAtMs: number,
): string | undefined {
  if (endsAtMsProvided !== undefined) return undefined;
  const durationHours = (resolvedEndsAtMs - startsAtMs) / 3_600_000;
  if (durationHours <= 24) return undefined;
  return (
    `endsAtMs was not provided and defaulted to now, producing a ${(durationHours / 24).toFixed(1)}-day window ` +
    '(preWindow and every control window inherit the same duration) — pass endsAtMs explicitly for a resolved/historical alert.'
  );
}

export interface ResolvedPanelForWindow {
  dashboard: DashboardJson;
  panel: ResolvedPanel;
  targets: ResolvedTarget[];
}

/**
 * Resolves a target's datasourceUid when it's a Grafana datasource-picker
 * template variable ($datasource, ${DS_PROMETHEUS}, ...) rather than a fixed
 * UID — see dashboards/variables.ts's resolveDatasourceVariable for why this
 * is needed at all. Only touches the client (an extra listDatasources() call)
 * when the ref actually looks like a variable reference; the common case
 * (a real UID already) is untouched and costs nothing extra.
 */
export async function resolveTargetDatasource(
  client: GrafanaClient,
  ref: string | undefined,
  variables: TemplateVariable[],
  overrides: Record<string, string[]>,
): Promise<string | undefined> {
  if (!ref || !ref.startsWith('$')) return ref;
  const resolved = resolveDatasourceVariable(ref, variables, overrides);
  if (!resolved) return resolved;
  // The variable's current value might already be a UID (modern Grafana) or
  // a datasource name (older Grafana) — only worth a lookup once we're
  // already on this exceptional path.
  const datasources = await client.listDatasources();
  if (datasources.some((d) => d.uid === resolved)) return resolved;
  return datasources.find((d) => d.name === resolved)?.uid ?? resolved;
}

/**
 * Fetches a dashboard, locates one panel, and substitutes its template
 * variables for a specific query window. Shared by execute_query_window and
 * detect_correlated_anomalies so both replay panels the same way.
 */
export async function resolvePanelForWindow(
  client: GrafanaClient,
  dashboardUid: string,
  panelId: number,
  overrides: Record<string, string[]>,
  window: QueryWindow,
  maxDataPoints: number,
  panelTitle?: string,
): Promise<ResolvedPanelForWindow> {
  const { dashboard } = await client.getDashboard(dashboardUid);
  const panel = findPanel(dashboard, panelId, panelTitle);
  if (!panel) {
    throw new Error(`Panel ${panelId} not found on dashboard ${dashboardUid}`);
  }
  if (panel.mirrorsPanelIds) {
    throw new Error(
      `Panel ${panelId} ("${panel.title ?? 'untitled'}") uses Grafana's built-in "-- Dashboard --" datasource — it ` +
        `re-displays panel ${panel.mirrorsPanelIds.join(', ')}'s already-computed value client-side and has no ` +
        `backend to query. Call this on panel ${panel.mirrorsPanelIds.join(', ')} directly instead.`,
    );
  }
  const variables = dashboard.templating?.list ?? [];
  const targets: ResolvedTarget[] = await Promise.all(
    panel.targets.map(async (t) => ({
      ...t,
      datasourceUid: await resolveTargetDatasource(client, t.datasourceUid, variables, overrides),
      raw: substituteTargetFields(t.raw, variables, overrides, window, maxDataPoints),
    })),
  );
  return { dashboard, panel, targets };
}
