import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { computeWindows, type TimeWindow } from '../query/windows.js';
import { executeQueryWindow, type QuerySeries } from '../query/executor.js';
import { compareToBaseline } from '../analysis/baseline.js';
import { resolvePanelForWindow } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

function seriesKey(series: QuerySeries): string {
  const labelStr = Object.entries(series.labels).sort().map(([k, v]) => `${k}=${v}`).join(',');
  return `${series.refId}|${labelStr}`;
}

export function registerValidateBaseline(server: McpServer, { client, config }: ToolContext): void {
  server.registerTool(
    'validate_baseline',
    {
      title: 'Validate baseline',
      description:
        'Compares the incident window against prior-hour, same-hour-yesterday, and same-hour-last-week control ' +
        'windows (or custom offsets) for one panel, per series. Classifies each series as "statistically-unusual" ' +
        '(z-score beyond threshold vs. the pooled baseline) or "common-during-normal-operations", and flags when a ' +
        'similar-magnitude window recurs daily/weekly so recurring patterns aren\'t mistaken for a fresh anomaly.',
      inputSchema: {
        dashboardUid: z.string(),
        panelId: z.number(),
        startsAtMs: z.number(),
        endsAtMs: z.number().optional(),
        variableOverrides: z.record(z.array(z.string())).optional(),
        zThreshold: z.number().optional().default(3),
        controlOffsets: z
          .array(z.object({ label: z.string(), offsetMs: z.number() }))
          .optional()
          .describe('Override the default prior-hour/day/week baseline windows, e.g. a configurable quiet period'),
      },
      annotations: { readOnlyHint: true, title: 'Validate baseline' },
    },
    async ({ dashboardUid, panelId, startsAtMs, endsAtMs, variableOverrides, zThreshold, controlOffsets }) => {
      try {
        return await withAudit('validate_baseline', { dashboardUid, panelId, startsAtMs, endsAtMs }, config, async () => {
          const windowSet = computeWindows({ startsAtMs, endsAtMs, controlOffsets });
          const overrides = variableOverrides ?? {};
          const allWindows: TimeWindow[] = [windowSet.incident, ...windowSet.controls];

          const executed = await Promise.all(
            allWindows.map(async (window) => {
              const { targets } = await resolvePanelForWindow(client, dashboardUid, panelId, overrides, window);
              return { window, result: await executeQueryWindow(client, targets, window, config) };
            }),
          );
          const [incidentExec, ...controlExecs] = executed;

          const seriesResults = incidentExec!.result.series.map((incidentSeries) => {
            const controlPoints = controlExecs.map((c) => ({
              label: c.window.label,
              points: c.result.series.find((s) => seriesKey(s) === seriesKey(incidentSeries))?.points ?? [],
            }));
            const comparison = compareToBaseline(incidentSeries.points, controlPoints, zThreshold);

            const recurringMatch = comparison.controlStats.find(
              (c) =>
                c.stats.count > 0 &&
                comparison.incidentStats.count > 0 &&
                Math.abs(c.stats.mean - comparison.incidentStats.mean) <= (c.stats.stddev || 1) * 1.5,
            );

            return {
              refId: incidentSeries.refId,
              labels: incidentSeries.labels,
              ...comparison,
              recurringPatternNote:
                comparison.classification === 'common-during-normal-operations' && recurringMatch
                  ? `Magnitude is similar to the "${recurringMatch.label}" window — looks like a recurring pattern, not a fresh anomaly.`
                  : undefined,
            };
          });

          const result = { window: windowSet.incident, controls: windowSet.controls, series: seriesResults };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns), null, 2) }] };
        });
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
