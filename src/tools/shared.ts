import { z } from 'zod';
import type { GrafanaClient } from '../grafana/client.js';
import type { ConnectionRegistry } from '../grafana/registry.js';
import type { DashboardJson, TemplateVariable } from '../grafana/types.js';
import { findPanel, type ResolvedPanel, type ResolvedTarget } from '../dashboards/panelQueries.js';
import { resolveDatasourceVariable, substituteTargetFields } from '../dashboards/variables.js';
import type { QueryWindow } from '../dashboards/variables.js';
import { resolveConnection } from '../connections/resolve.js';

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
): Promise<ResolvedPanelForWindow> {
  const { dashboard } = await client.getDashboard(dashboardUid);
  const panel = findPanel(dashboard, panelId);
  if (!panel) {
    throw new Error(`Panel ${panelId} not found on dashboard ${dashboardUid}`);
  }
  const variables = dashboard.templating?.list ?? [];
  const targets: ResolvedTarget[] = await Promise.all(
    panel.targets.map(async (t) => ({
      ...t,
      datasourceUid: await resolveTargetDatasource(client, t.datasourceUid, variables, overrides),
      raw: substituteTargetFields(t.raw, variables, overrides, window),
    })),
  );
  return { dashboard, panel, targets };
}
