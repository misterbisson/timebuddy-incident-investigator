import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { summarizeFindings, type SummarizeFindingsInput } from '../analysis/summarize.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';
import { toolErrorResult } from './shared.js';

// Numeric fields that are NaN when a series has no data serialize to `null`
// over JSON (JSON.stringify(NaN) === "null"), so a value round-tripped from
// validate_baseline's tool output will arrive here as null, not NaN.
const nullableNumber = z.number().nullable();

const seriesStatsSchema = z.object({
  mean: nullableNumber,
  stddev: nullableNumber,
  min: nullableNumber,
  max: nullableNumber,
  count: z.number(),
  nonZeroCount: z.number().optional().default(0),
});

const thresholdRunSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  durationMs: z.number(),
  minValue: z.number(),
  maxValue: z.number(),
  pointCount: z.number(),
});

const baselineSchema = z.object({
  incidentStats: seriesStatsSchema,
  controlStats: z.array(z.object({ label: z.string(), stats: seriesStatsSchema })),
  pooledBaselineMean: nullableNumber,
  pooledBaselineStddev: nullableNumber,
  zScore: nullableNumber,
  classification: z.enum(['statistically-unusual', 'common-during-normal-operations', 'insufficient-data']),
  briefExcursions: z
    .array(thresholdRunSchema)
    .optional()
    .default([])
    .describe('Carry over validate_baseline\'s own "briefExcursions" for this series unchanged - a whole-window classification of "common" can still hide a real, brief, diluted event that only this array would catch.'),
});

const correlationResultSchema = z.object({
  dashboardUid: z.string(),
  dashboardTitle: z.string(),
  panelId: z.number(),
  panelTitle: z.string().optional(),
  labels: z.record(z.string()),
  zScore: z.number(),
  labelOverlapCount: z.number(),
  onsetLagMs: z.number().optional(),
  score: z.number(),
});

const evidenceLinkSchema = z.object({
  description: z.string(),
  dashboardUid: z.string().optional(),
  panelId: z.number().optional(),
  url: z.string().optional(),
});

function toNaN(value: number | null): number {
  return value === null ? NaN : value;
}

export function registerSummarizeFindings(server: McpServer, { config }: ToolContext): void {
  server.registerTool(
    'summarize_findings',
    {
      title: 'Summarize findings',
      description:
        'Assembles the outputs of get_alert_context, validate_baseline, and detect_correlated_anomalies into a ' +
        'structured verdict (real-anomaly / likely-false-positive / inconclusive) with an evidence-linked bundle. ' +
        'Pass validate_baseline\'s own "briefExcursions" through in "baseline" unchanged - a whole-window mean can ' +
        'dilute a real, brief, severe event into looking "common", so this never returns likely-false-positive when ' +
        'brief excursions are present, even if the whole-window classification alone would suggest it. ' +
        'This tool does deterministic rule-based classification only — it does not generate prose. Write the ' +
        'human-readable incident note yourself from the returned reasons/evidence, so every claim in it traces back ' +
        'to a specific dashboard/panel/query result.',
      inputSchema: {
        alertName: z.string().optional(),
        labels: z.record(z.string()).default({}),
        baseline: baselineSchema.describe('The result of validate_baseline for the alert\'s primary series'),
        thresholdCrossed: z.boolean().optional().describe('Whether the incident window crossed the alert\'s own threshold, if known'),
        correlated: z.array(correlationResultSchema).optional().default([]).describe('The "correlated" array from detect_correlated_anomalies'),
        correlationScoreThreshold: z.number().optional().describe('Minimum score to count a candidate as confirmed-related rather than just checked'),
        evidence: z.array(evidenceLinkSchema).optional().default([]).describe('Dashboard/panel/query links backing this finding'),
        warnings: z.array(z.string()).optional().default([]).describe('Carry over any warnings from get_alert_context, e.g. missing dashboard link'),
      },
      annotations: { readOnlyHint: true, title: 'Summarize findings' },
    },
    async (args) => {
      try {
        return await withAudit('summarize_findings', { alertName: args.alertName }, config, async () => {
          const input: SummarizeFindingsInput = {
            alertName: args.alertName,
            labels: args.labels,
            thresholdCrossed: args.thresholdCrossed,
            correlated: args.correlated,
            correlationScoreThreshold: args.correlationScoreThreshold,
            evidence: args.evidence,
            warnings: args.warnings,
            baseline: {
              incidentStats: {
                mean: toNaN(args.baseline.incidentStats.mean),
                stddev: toNaN(args.baseline.incidentStats.stddev),
                min: toNaN(args.baseline.incidentStats.min),
                max: toNaN(args.baseline.incidentStats.max),
                count: args.baseline.incidentStats.count,
                nonZeroCount: args.baseline.incidentStats.nonZeroCount,
              },
              controlStats: args.baseline.controlStats.map((c) => ({
                label: c.label,
                stats: {
                  mean: toNaN(c.stats.mean),
                  stddev: toNaN(c.stats.stddev),
                  min: toNaN(c.stats.min),
                  max: toNaN(c.stats.max),
                  count: c.stats.count,
                  nonZeroCount: c.stats.nonZeroCount,
                },
              })),
              pooledBaselineMean: toNaN(args.baseline.pooledBaselineMean),
              pooledBaselineStddev: toNaN(args.baseline.pooledBaselineStddev),
              zScore: toNaN(args.baseline.zScore),
              classification: args.baseline.classification,
              briefExcursions: args.baseline.briefExcursions,
            },
          };
          const report = summarizeFindings(input);
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(report, config.redactionPatterns)) }] };
        });
      } catch (err) {
        return toolErrorResult(err, config);
      }
    },
  );
}
