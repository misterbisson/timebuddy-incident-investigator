import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { computeWindows } from '../query/windows.js';
import { executeQueryWindows } from '../query/executor.js';
import { resolvePanelForWindow } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

export function registerExecuteQueryWindow(server: McpServer, { client, config }: ToolContext): void {
  server.registerTool(
    'execute_query_window',
    {
      title: 'Execute query window',
      description:
        'Replays one dashboard panel\'s queries (with template variables substituted) through Grafana\'s /api/ds/query ' +
        'for the incident window, a pre-window buffer (to see the anomaly\'s onset), and baseline control windows ' +
        '(prior hour, same-hour-yesterday, same-hour-last-week by default). Returns per-window time series so the ' +
        'caller can compare magnitudes directly, or feed them into validate_baseline / detect_correlated_anomalies.',
      inputSchema: {
        dashboardUid: z.string(),
        panelId: z.number(),
        startsAtMs: z.number().describe('Incident start, epoch ms (e.g. the alert\'s startsAt)'),
        endsAtMs: z.number().optional().describe('Incident end, epoch ms; defaults to now for still-firing alerts'),
        preWindowMs: z.number().optional().describe('Buffer before the incident start, ms; defaults to max(30min, incident duration)'),
        variableOverrides: z.record(z.array(z.string())).optional(),
        includeControls: z.boolean().optional().default(true).describe('Include prior-hour/day/week baseline windows'),
      },
      annotations: { readOnlyHint: true, title: 'Execute query window' },
    },
    async ({ dashboardUid, panelId, startsAtMs, endsAtMs, preWindowMs, variableOverrides, includeControls }) => {
      try {
        return await withAudit('execute_query_window', { dashboardUid, panelId, startsAtMs, endsAtMs }, config, async () => {
          const windowSet = computeWindows({
            startsAtMs,
            endsAtMs,
            preWindowMs,
            controlOffsets: includeControls ? undefined : [],
          });
          const allWindows = [windowSet.incident, windowSet.preWindow, ...windowSet.controls];
          const overrides = variableOverrides ?? {};

          // Variable values don't depend on the window, but $__interval/$timeFilter
          // do — resolve targets once per window rather than once overall.
          const resultsPerWindow = await Promise.all(
            allWindows.map(async (window) => {
              const { targets } = await resolvePanelForWindow(client, dashboardUid, panelId, overrides, window);
              const [result] = await executeQueryWindows(client, targets, [window], config);
              return result!;
            }),
          );

          const [incident, preWindow, ...controls] = resultsPerWindow;
          const result = { incident, preWindow, controls };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns), null, 2) }] };
        });
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
