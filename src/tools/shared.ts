import type { GrafanaClient } from '../grafana/client.js';
import type { ConnectionRegistry } from '../grafana/registry.js';
import type { DashboardJson } from '../grafana/types.js';
import { findPanel, type ResolvedPanel, type ResolvedTarget } from '../dashboards/panelQueries.js';
import { substituteTargetFields } from '../dashboards/variables.js';
import type { QueryWindow } from '../dashboards/variables.js';
import { resolveConnection } from '../connections/resolve.js';

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
  const targets: ResolvedTarget[] = panel.targets.map((t) => ({
    ...t,
    raw: substituteTargetFields(t.raw, variables, overrides, window),
  }));
  return { dashboard, panel, targets };
}
