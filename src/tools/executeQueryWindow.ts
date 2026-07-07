import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { computeWindows } from '../query/windows.js';
import { executeQueryWindows, type WindowQueryResult } from '../query/executor.js';
import { findThresholdRuns } from '../analysis/runs.js';
import { epochMsSchema, resolvePanelForWindow, resolveToolClient } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

/** Attaches per-series threshold-crossing runs, when a threshold was requested. */
function withRuns(result: WindowQueryResult, threshold: number | undefined, direction: 'below' | 'above') {
  if (threshold === undefined) return result;
  return {
    ...result,
    series: result.series.map((s) => ({ ...s, runs: findThresholdRuns(s.points, threshold, direction) })),
  };
}

export function registerExecuteQueryWindow(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'execute_query_window',
    {
      title: 'Execute query window',
      description:
        'Replays one dashboard panel\'s queries (with template variables substituted) through Grafana\'s /api/ds/query ' +
        'for the incident window, a pre-window buffer (to see the anomaly\'s onset), and baseline control windows ' +
        '(prior hour, same-hour-yesterday, same-hour-last-week by default). Returns per-window time series so the ' +
        'caller can compare magnitudes directly, or feed them into validate_baseline / detect_correlated_anomalies. ' +
        'Pass "threshold" (and optionally "thresholdDirection") to get each series\' precise dip/spike windows back ' +
        'directly — e.g. threshold: 1, thresholdDirection: "below" for an uptime-style metric (1.0 = fully up) finds ' +
        'exactly when each refId/series dropped below full health and for how long, including whether sibling ' +
        'series (e.g. other hosts/cells in the same panel) dipped too. Always prefer this over fetching the raw ' +
        'points and scripting the same analysis yourself.',
      inputSchema: {
        dashboardUid: z.string(),
        panelId: z.number(),
        startsAtMs: epochMsSchema.describe('Incident start — epoch ms or an ISO 8601 date/time (e.g. the alert\'s startsAt, or "2026-06-08T00:00:00Z")'),
        endsAtMs: epochMsSchema.optional().describe('Incident end — epoch ms or ISO 8601; defaults to now for still-firing alerts'),
        preWindowMs: z.number().optional().describe('Buffer before the incident start, ms; defaults to max(30min, incident duration)'),
        variableOverrides: z.record(z.array(z.string())).optional(),
        includeControls: z.boolean().optional().default(true).describe('Include prior-hour/day/week baseline windows'),
        threshold: z.number().optional().describe('When set, each returned series gets a "runs" array of contiguous points crossing this value (start/end/duration/min/max) - e.g. 1 for an uptime metric'),
        thresholdDirection: z.enum(['below', 'above']).optional().default('below').describe('Whether "threshold" means find runs below or above that value'),
        connection: z.string().optional().describe('Connection id to use, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Execute query window' },
    },
    async ({ dashboardUid, panelId, startsAtMs, endsAtMs, preWindowMs, variableOverrides, includeControls, threshold, thresholdDirection, connection }) => {
      try {
        return await withAudit('execute_query_window', { dashboardUid, panelId, startsAtMs, endsAtMs }, config, async () => {
          const { client } = resolveToolClient(registry, { connection });
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
              return withRuns(result!, threshold, thresholdDirection);
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
