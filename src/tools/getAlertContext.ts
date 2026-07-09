import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { resolveAlertContext } from '../alerts/ingest.js';
import { getLatestWebhook, getWebhookByFingerprint } from '../webhook/store.js';
import { resolveConnection } from '../connections/resolve.js';
import { dashboardUrlFor } from './shared.js';
import { resolveProductContext } from '../knowledge/lookup.js';
import type { ProductKnowledge } from '../knowledge/types.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

function summarize(ctx: Awaited<ReturnType<typeof resolveAlertContext>>): string {
  const parts: string[] = [];
  parts.push(ctx.alertName ? `Alert "${ctx.alertName}"` : 'Unnamed alert');
  if (ctx.status) parts.push(`status=${ctx.status}`);
  const labelPairs = Object.entries(ctx.labels).slice(0, 6).map(([k, v]) => `${k}=${v}`);
  if (labelPairs.length) parts.push(`labels: ${labelPairs.join(', ')}`);
  if (ctx.dashboardUid) {
    parts.push(`linked to dashboard ${ctx.dashboardUid}${ctx.panelId !== undefined ? ` panel ${ctx.panelId}` : ''}`);
  } else {
    parts.push('no linked dashboard panel found');
  }
  if (ctx.threshold) parts.push(`threshold: ${ctx.threshold}`);
  return parts.join('; ');
}

export function registerGetAlertContext(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'get_alert_context',
    {
      title: 'Get alert context',
      description:
        'Ingests a Grafana alert from a pasted Alertmanager webhook payload, a single pasted alert JSON object, ' +
        'a dashboard/panel/alert-rule URL, or (with no arguments) the most recently received webhook. Resolves it ' +
        'to dashboard UID, panel ID, labels, annotations, threshold, and time range, and produces a one-line ' +
        '"what fired and why" summary. When multiple Grafana connections are configured, also resolves which one ' +
        'the alert belongs to (by matching the alert\'s URL host, or the explicit "connection" param) and returns ' +
        'it as resolvedConnectionId — pass that as "connection" on every subsequent tool call for this incident. ' +
        'Also returns "dashboardUrl", a ready-to-click link to the resolved dashboard/panel/time-window — always ' +
        'share this link when referencing the dashboard, even if the alert itself already carried a URL. When a ' +
        'folder in this Grafana estate publishes a "Timebuddy knowledge" dashboard (see README), also returns ' +
        '"knowledge" - product-specific context (matched via the resolved dashboard\'s tags or the alert\'s own ' +
        'labels) worth folding into your answer. Absent when nothing was published; this is purely additive.',
      inputSchema: {
        webhookPayload: z.unknown().optional().describe('A full Grafana Alertmanager webhook JSON body (has an "alerts" array)'),
        alertJson: z.unknown().optional().describe('A single pasted alert object (labels/annotations/status/...)'),
        url: z.string().optional().describe('A Grafana dashboard, panel, or alert-rule URL'),
        fingerprint: z.string().optional().describe('Select a specific alert by fingerprint from a webhook payload or the stored alert history'),
        connection: z.string().optional().describe('Explicit connection id to use/override, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Get alert context' },
    },
    async (args) => {
      try {
        return await withAudit('get_alert_context', { hasUrl: Boolean(args.url), fingerprint: args.fingerprint }, config, async () => {
          let webhookPayload = args.webhookPayload;
          if (!webhookPayload && !args.alertJson && !args.url) {
            const stored = args.fingerprint
              ? await getWebhookByFingerprint(args.fingerprint, config)
              : await getLatestWebhook(config);
            if (!stored) {
              throw new Error(
                'No webhookPayload, alertJson, or url provided, and no alert has been received by the webhook listener yet.',
              );
            }
            webhookPayload = stored.payload;
          }

          // resolveAlertContext only needs a client for the alert-rule-URL
          // path; resolve a connection lazily so webhook/pasted-JSON input
          // never requires one up front.
          let resolvedConnectionId: string | undefined;
          const getClient = (hintUrl?: string) => {
            const resolved = resolveConnection({ explicitId: args.connection, hintUrl }, registry.list());
            resolvedConnectionId = resolved.connection.id;
            return registry.get(resolved.connection.id);
          };

          const alertContext = await resolveAlertContext(
            { webhookPayload, alertJson: args.alertJson, url: args.url, fingerprint: args.fingerprint },
            getClient,
          );

          if (!resolvedConnectionId) {
            try {
              const resolved = resolveConnection(
                { explicitId: args.connection, hintUrl: alertContext.panelURL ?? alertContext.dashboardURL ?? alertContext.generatorURL },
                registry.list(),
              );
              resolvedConnectionId = resolved.connection.id;
            } catch (err) {
              alertContext.warnings.push(
                `Could not resolve a Grafana connection: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          // Synthesized fresh even when the alert already carried a
          // panelURL/dashboardURL, since a webhook/pasted-JSON alert linked
          // only via __dashboardUid__/__panelId__ annotations often has no
          // URL at all — this is the one place that's guaranteed to produce
          // a clickable link whenever a dashboard/panel was resolved.
          const parseMsOrUndefined = (iso: string | undefined): number | undefined => {
            if (!iso) return undefined;
            const parsed = Date.parse(iso);
            return Number.isFinite(parsed) ? parsed : undefined;
          };
          const dashboardUrl =
            resolvedConnectionId && alertContext.dashboardUid
              ? dashboardUrlFor(registry, resolvedConnectionId, alertContext.dashboardUid, {
                  panelId: alertContext.panelId,
                  fromMs: parseMsOrUndefined(alertContext.startsAt),
                  toMs: parseMsOrUndefined(alertContext.endsAt),
                  variables: alertContext.variables,
                })
              : undefined;

          let knowledge: ProductKnowledge | undefined;
          if (resolvedConnectionId && alertContext.dashboardUid) {
            try {
              const client = registry.get(resolvedConnectionId);
              const { dashboard, meta } = await client.getDashboard(alertContext.dashboardUid);
              const candidateKeys = [...(dashboard.tags ?? []), ...Object.values(alertContext.labels ?? {})];
              knowledge = await resolveProductContext(client, config, resolvedConnectionId, {
                startFolderUid: meta.folderUid,
                candidateKeys,
              });
            } catch (err) {
              // A knowledge-dashboard lookup failure is a nice-to-have gone
              // missing, not a reason to fail an otherwise-successful alert
              // resolution — degrade to "no knowledge attached" plus a
              // warning, same as the connection-resolution fallback above.
              alertContext.warnings.push(
                `Could not check for a product knowledge dashboard: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          const result = redact(
            {
              summary: summarize(alertContext),
              alertContext,
              resolvedConnectionId,
              dashboardUrl,
              knowledge,
            },
            config.redactionPatterns,
          );
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        });
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
