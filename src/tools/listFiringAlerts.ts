import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import type { AlertmanagerAlert } from '../grafana/types.js';
import { resolveToolClient, toolErrorResult } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

/**
 * One firing alert, trimmed to the fields worth showing — but kept in the same
 * shape get_alert_context accepts as `alertJson` (labels + annotations + status,
 * no `alerts` array), so an agent can pipe a chosen entry straight back into
 * get_alert_context({ alertJson }) to start an investigation without re-typing
 * anything. The `source` link is the alert's own generator/panel URL, handy
 * when you'd rather hand get_alert_context a `url` instead.
 */
export interface FiringAlertSummary {
  fingerprint: string;
  status: { state: string };
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt?: string;
  source?: string;
}

function toSummary(a: AlertmanagerAlert): FiringAlertSummary {
  return {
    fingerprint: a.fingerprint,
    status: a.status,
    labels: a.labels ?? {},
    annotations: a.annotations ?? {},
    startsAt: a.startsAt,
    endsAt: a.status?.state === 'resolved' ? a.endsAt : undefined,
    source: a.panelURL ?? a.dashboardURL ?? a.generatorURL,
  };
}

/** true when every key in `filters` matches the alert's label of the same name (case-sensitive, exact). */
function matchesLabels(a: AlertmanagerAlert, filters: Record<string, string>): boolean {
  return Object.entries(filters).every(([k, v]) => a.labels?.[k] === v);
}

/**
 * Filters and summarizes the alerts a connection reports for the tool response
 * — exported for direct testing. Sorted most-recently-started first so the
 * freshest incidents lead, and truncated to `limit`.
 */
export function filterFiringAlerts(
  alerts: AlertmanagerAlert[],
  opts: { labelFilters?: Record<string, string>; limit?: number } = {},
): FiringAlertSummary[] {
  const filtered = opts.labelFilters ? alerts.filter((a) => matchesLabels(a, opts.labelFilters!)) : alerts;
  const sorted = [...filtered].sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  return (opts.limit !== undefined ? sorted.slice(0, opts.limit) : sorted).map(toSummary);
}

export function registerListFiringAlerts(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'list_firing_alerts',
    {
      title: 'List firing alerts',
      description:
        'Lists the alerts currently active in Grafana\'s Alertmanager — the "what\'s on fire right now" view. Use ' +
        'this when someone points you at a live incident without pasting a specific alert ("look at what\'s ' +
        'firing", "the eu-central-1 alerts", "we\'re getting paged") and you have nothing to feed get_alert_context ' +
        'yet: it enumerates the active alerts so you can pick the relevant one. Each entry comes back in the exact ' +
        'shape get_alert_context accepts as "alertJson" (fingerprint, status, labels, annotations, startsAt, and a ' +
        '"source" link) — hand a chosen entry straight to get_alert_context({ alertJson: <entry> }) (or pass its ' +
        '"source" as "url") to start the investigation, no re-typing. Pass "labelFilters" (exact key=value label ' +
        'matches, e.g. {"region":"eu-central-1","severity":"critical"}) to narrow a busy estate. Pass "connection" ' +
        'to query one Grafana connection; omit it to fan out across every configured connection (results grouped ' +
        'by connection id). This reads the live Alertmanager state — it does not silence, acknowledge, or modify ' +
        'anything.',
      inputSchema: {
        labelFilters: z
          .record(z.string(), z.string())
          .optional()
          .describe('Exact label key=value matches; an alert must match all pairs to be listed (e.g. {"region":"eu-central-1"})'),
        limit: z.number().optional().default(50).describe('Max alerts per connection, most-recently-started first'),
        connection: z.string().optional().describe('Query only this connection; omit to fan out across every configured connection'),
      },
      annotations: { readOnlyHint: true, title: 'List firing alerts' },
    },
    async ({ labelFilters, limit, connection }) => {
      try {
        return await withAudit('list_firing_alerts', { connection, hasLabelFilters: Boolean(labelFilters) }, config, async () => {
          const connections = connection
            ? [resolveToolClient(registry, { connection }).connectionId]
            : registry.list().map((c) => c.id);

          const perConnection = await Promise.allSettled(
            connections.map(async (connectionId) => {
              const client = registry.get(connectionId);
              const alerts = await client.getFiringAlerts();
              return { connectionId, alerts: filterFiringAlerts(alerts, { labelFilters, limit }) };
            }),
          );

          const fulfilled = perConnection.filter(
            (r): r is PromiseFulfilledResult<{ connectionId: string; alerts: FiringAlertSummary[] }> =>
              r.status === 'fulfilled',
          );
          // A connection that errored (unreachable, auth, alertmanager disabled)
          // shouldn't silently vanish as "no alerts firing" — surface which ones
          // couldn't be reached so a clean result isn't mistaken for all-clear.
          const failedConnections = connections.filter(
            (id) => !fulfilled.some((r) => r.value.connectionId === id),
          );

          const alertsByConnection = Object.fromEntries(fulfilled.map((r) => [r.value.connectionId, r.value.alerts]));
          const count = fulfilled.reduce((n, r) => n + r.value.alerts.length, 0);

          const result = {
            alertsByConnection,
            count,
            ...(failedConnections.length ? { failedConnections } : {}),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        return toolErrorResult(err, config);
      }
    },
  );
}
