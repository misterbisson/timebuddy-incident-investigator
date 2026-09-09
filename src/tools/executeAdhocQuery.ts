import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import type { Config } from '../config.js';
import type { GrafanaClient } from '../grafana/client.js';
import type { ResolvedTarget } from '../dashboards/panelQueries.js';
import { executeQueryWindow, type QuerySeries } from '../query/executor.js';
import { classifyInfluxQL, type AdhocVerdict } from '../query/adhocGuard.js';
import { MAX_STEP_SECONDS, classifyPromQL, resolvePromqlStep } from '../query/promqlGuard.js';
import { computeStats } from '../analysis/baseline.js';
import { clampSeriesPoints } from '../security/limits.js';
import { resolutionFromTimestamps } from '../export/csv.js';
import { buildExploreUrl } from '../grafana/urlBuilder.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';
import { epochMsSchema, resolveToolClient, toolErrorResult } from './shared.js';

/** Prometheus' two evaluation modes: a series over the window, or one value at its end. */
type PromQueryType = 'range' | 'instant';

/** The dialect-specific parameters, already validated by zod but not yet checked against the dialect. */
interface AdhocRequest {
  fromMs: number;
  toMs: number;
  queryType?: PromQueryType;
  stepSeconds?: number;
}

interface PreparedQuery {
  /** The query body sent to /api/ds/query; refId/datasource/maxDataPoints are added by the executor. */
  raw: Record<string, unknown>;
  /** Pane fields the Explore link needs so it opens the same shape that ran. */
  explore: { instant?: boolean; stepSeconds?: number };
  /** Merged into the tool result — what resolution/mode this ran at, in the dialect's own terms. */
  resultFields: Record<string, unknown>;
  /**
   * The step this query asked for, when the dialect has one. Set so the tool can
   * compare it against the spacing actually returned — see reportedStep below.
   */
  requestedStepMs?: number;
}

/**
 * One query language this tool knows how to accept: how to classify it as
 * runnable, and how to shape the request for it.
 *
 * A datasource type absent from GUARDABLE_TYPES below is refused even when a
 * workspace's policy names it, because authorization and *verifiability* are
 * different questions: a policy says the operator is willing, this map says we
 * can actually tell a read from a write in that query language — or, for a
 * language with no write form, that we know why we don't have to.
 */
interface AdhocDialect {
  /** Name used in refusal messages, so a refusal says PromQL/InfluxQL rather than a datasource type. */
  language: string;
  classify: (query: string) => AdhocVerdict;
  /** Validates the dialect-specific params and builds the request. Throws with an actionable message. */
  prepare: (statement: string, req: AdhocRequest, config: Config) => PreparedQuery;
}

/** Refuses a parameter that means nothing for the dialect in play, rather than accepting and ignoring it. */
function refuseUnusedParam(name: string, language: string, instead: string): never {
  throw new Error(`"${name}" does not apply to ${language} queries — ${instead}`);
}

const INFLUXQL: AdhocDialect = {
  language: 'InfluxQL',
  classify: classifyInfluxQL,
  prepare: (statement, req) => {
    // Silently ignoring a step here would be the same class of bug issue #200
    // is about, one level up: the caller would believe they had set the
    // resolution when InfluxQL takes it from the query's own GROUP BY.
    if (req.stepSeconds !== undefined) {
      refuseUnusedParam('stepSeconds', 'InfluxQL', 'set the resolution in the query itself with GROUP BY time(...)');
    }
    if (req.queryType !== undefined) {
      refuseUnusedParam('queryType', 'InfluxQL', 'it selects between a Prometheus range and instant query');
    }
    return {
      raw: { query: statement, rawQuery: true, resultFormat: 'time_series' },
      explore: {},
      resultFields: {},
    };
  },
};

const PROMQL: AdhocDialect = {
  language: 'PromQL',
  classify: classifyPromQL,
  prepare: (statement, req, config) => {
    const queryType: PromQueryType = req.queryType ?? 'range';
    if (queryType === 'instant') {
      if (req.stepSeconds !== undefined) {
        refuseUnusedParam(
          'stepSeconds',
          'instant PromQL',
          'an instant query evaluates at a single timestamp (the window end), so there is no step. ' +
            'Drop it, or use queryType:"range" to get a series.',
        );
      }
      return {
        // No `interval` on an instant query: Grafana's Prometheus backend
        // evaluates it at the range end and ignores any step, so sending one
        // would be a field the result can't be checked against.
        raw: {
          expr: statement,
          instant: true,
          range: false,
          exemplar: false,
          editorMode: 'code',
          format: 'time_series',
        },
        explore: { instant: true },
        // Named rather than left implicit: "instant at toMs" is a different
        // question from "the series over [fromMs, toMs]", and a caller reading
        // a one-point result needs to know which one it answered.
        resultFields: { queryType, evaluatedAtMs: req.toMs },
      };
    }

    if (req.stepSeconds === undefined) {
      // A hard error, not a default. See resolvePromqlStep's doc comment (and
      // issue #200) for what an inferred step costs on a range-vector query.
      const suggestion = Math.max(15, Math.ceil((req.toMs - req.fromMs) / 1000 / 200));
      throw new Error(
        'PromQL range queries require an explicit "stepSeconds" — it is never inferred. The step decides the ' +
          'answer for every range-vector function (rate/increase/delta/*_over_time), so choosing it for you is ' +
          `how a replay reports a signal that does not exist at the resolution you meant (issue #200). Pass the ` +
          `datasource's scrape interval to measure real samples (e.g. stepSeconds: 15 or 60), or ` +
          `stepSeconds: ${suggestion} for a ~200-point overview of this window. Use queryType:"instant" for a ` +
          'single value at the window end instead.',
      );
    }
    const plan = resolvePromqlStep({
      fromMs: req.fromMs,
      toMs: req.toMs,
      stepSeconds: req.stepSeconds,
      maxDataPoints: config.maxDataPoints,
    });
    return {
      // Both `interval` and `intervalMs`: Grafana's Prometheus query model
      // carries the string form (what a panel stores as its min step) and the
      // backend reads the numeric one. Sending both means the step survives
      // whichever field the instance's version reads, instead of falling back
      // to the datasource's scrape-interval setting — which is what made
      // execute_query_window run at 15s against a panel pinning 1m (#200).
      raw: {
        expr: statement,
        instant: false,
        range: true,
        interval: `${req.stepSeconds}s`,
        intervalMs: plan.stepMs,
        exemplar: false,
        editorMode: 'code',
        format: 'time_series',
      },
      explore: { stepSeconds: req.stepSeconds },
      resultFields: { queryType },
      requestedStepMs: plan.stepMs,
    };
  },
};

/**
 * The only datasource types this tool knows how to accept a query for.
 *
 * Raw-SQL types (postgres/mysql/mssql) are deliberately absent and should stay
 * that way unless someone writes a real guard for them — their query body is
 * arbitrary SQL over a connection whose credential we can't inspect, so "begins
 * with SELECT" is a much weaker claim there than in InfluxQL (CTEs that write,
 * stored procedures, multiple result sets).
 *
 * `prometheus` covers the case issue #212 is actually about: several
 * VictoriaMetrics instances in the wild are configured as Grafana `prometheus`
 * datasources, and the whole point of the request was being able to probe which
 * one a datasource really is. The standalone `victoriametrics-datasource` plugin
 * type is *not* listed — MetricsQL has no write form either, but that plugin's
 * query model isn't exercised anywhere in this repo, and guessing at a query
 * body is how a tool sends something other than what it reported sending.
 *
 * `loki` is absent for a different reason: LogQL also has no write form, but a
 * log query's results are lines rather than series, and `search_logs` /
 * `correlate_logs` already own that path.
 */
const GUARDABLE_TYPES: Record<string, AdhocDialect> = {
  influxdb: INFLUXQL,
  prometheus: PROMQL,
};

/**
 * Resolves the datasource to query and checks it against the workspace's policy.
 * Split out so the refusal path is one place and every refusal names both what
 * was asked and what is allowed — a bare "not permitted" gets retried blindly,
 * while a message listing the authorized types gets corrected or abandoned.
 */
async function resolveAuthorizedDatasource(
  client: GrafanaClient,
  requestedUid: string,
  authorizedTypes: string[],
): Promise<{ uid: string; type: string }> {
  if (authorizedTypes.length === 0) {
    throw new Error(
      'This connection is not authorized for ad-hoc queries. Authorization is per-workspace: it comes from a ' +
        '--allow-adhoc-queries=<host>:<datasourceType> launch flag (typically in the repo\'s .mcp.json), not from ' +
        'anything settable at runtime. Use the dashboard-derived tools (resolve_panel_queries, ' +
        'execute_query_window) against this connection instead.',
    );
  }
  const datasources = await client.listDatasources();
  const found = datasources.find((d) => d.uid === requestedUid);
  if (!found) {
    throw new Error(
      `No datasource with uid "${requestedUid}" on this connection. Call list_datasources to see what exists.`,
    );
  }
  const type = found.type.toLowerCase();
  if (!authorizedTypes.includes(type)) {
    throw new Error(
      `Datasource "${found.name}" is type "${type}", which this workspace is not authorized to query ad-hoc. ` +
        `Authorized here: ${authorizedTypes.join(', ')}.`,
    );
  }
  if (!(type in GUARDABLE_TYPES)) {
    throw new Error(
      `Ad-hoc queries against "${type}" datasources are not supported, even though this workspace authorizes ` +
        `them: there is no read-only statement guard for that query language yet, and running unguarded query ` +
        `text is exactly what this tool exists to avoid. Supported: ${Object.keys(GUARDABLE_TYPES).join(', ')}.`,
    );
  }
  return { uid: found.uid, type };
}

/**
 * Reports the resolution the query *actually* came back at, next to the one it
 * asked for.
 *
 * This is the smaller half of issue #200's ask ("report the step") applied where
 * it's cheapest to honour: the requested step is a request, and Grafana's
 * Prometheus backend can still enlarge it (its own safe-resolution clamp), or an
 * older instance can read a field we didn't send. Rather than assert the step
 * held, derive it from the returned timestamps — the median gap, exact — and say
 * plainly when the two disagree. A caller measuring scrape density with
 * `count_over_time(x[1m])` is asking a question *about* the step; handing them an
 * unverified echo of their own input would be the wrong answer to give
 * confidently.
 *
 * Deliberately measured on the pre-clamp series: clampSeriesPoints downsamples
 * with a uniform stride for the response, so measuring after it would report the
 * stride rather than the datasource's step.
 */
function reportedStep(series: QuerySeries[], requestedStepMs: number): Record<string, unknown> {
  const measurable = series.find((s) => s.points.length >= 2);
  const observed = measurable ? resolutionFromTimestamps(measurable.points.map((p) => p.t)) : undefined;
  if (!observed) {
    return {
      step: {
        requestedMs: requestedStepMs,
        note: 'Too few points returned to measure the effective step — the datasource may have no data in this window.',
      },
    };
  }
  const matchesRequested = observed.effectiveBucketMs === requestedStepMs;
  return {
    step: {
      requestedMs: requestedStepMs,
      effectiveMs: observed.effectiveBucketMs,
      points: observed.points,
      matchesRequested,
      ...(matchesRequested
        ? {}
        : {
            note:
              `The datasource evaluated this at ${observed.effectiveBucketMs}ms, not the requested ` +
              `${requestedStepMs}ms. Any range-vector function here (rate/increase/delta/*_over_time) answered at ` +
              'the effective step, so read the numbers against that one.',
          }),
    },
  };
}

export function registerExecuteAdhocQuery(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'execute_adhoc_query',
    {
      title: 'Execute an ad-hoc query',
      description:
        'Runs a query you write yourself against a datasource, over an explicit time window, and returns the ' +
        'resulting series plus a Grafana Explore URL that re-runs exactly that query. Accepts InfluxQL against an ' +
        'InfluxDB datasource and PromQL/MetricsQL against a Prometheus-type one, dispatching on the datasource\'s ' +
        'type. Unlike every other query tool here, the query text comes from you rather than from a dashboard a ' +
        'human authored and validated — so results carry provenance:"adhoc", and a verdict resting on them must ' +
        'say so. Prefer the dashboard-derived path first: find_related_dashboards / resolve_panel_queries / ' +
        'execute_query_window reproduce what the service owners actually chose to measure, including aggregation ' +
        'and retention policy choices that are easy to get subtly wrong by hand. Reach for this only when that ' +
        'path came up empty, or when iterating on a query you intend to put on a dashboard — including questions ' +
        'about the data\'s own shape that no panel answers, e.g. count_over_time(metric[1m]) to measure real ' +
        'scrape density, or a MetricsQL-only construct to tell a VictoriaMetrics instance from a Prometheus one. ' +
        'PromQL range queries require an explicit stepSeconds: the step decides the answer for every ' +
        'range-vector function, so it is never inferred, and the result reports the step the datasource actually ' +
        'used alongside the one you asked for. Read-only: PromQL has no write form and Grafana only reaches its ' +
        'query endpoints, while InfluxQL is restricted to single-statement SELECT/SHOW — and only datasource ' +
        'types this workspace explicitly authorized are reachable at all. Goes through the same connection ' +
        'resolution, limits, redaction, and audit logging as every other tool.',
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .max(8000)
          .describe(
            'The query text, in the datasource\'s own language: InfluxQL (a single SELECT or SHOW statement) for ' +
              'an InfluxDB datasource, or a single PromQL/MetricsQL expression for a Prometheus-type one',
          ),
        datasourceUid: z.string().describe('Which datasource to query — from list_datasources'),
        fromMs: epochMsSchema.describe('Window start (epoch ms or ISO 8601)'),
        toMs: epochMsSchema.describe('Window end (epoch ms or ISO 8601)'),
        queryType: z
          .enum(['range', 'instant'])
          .optional()
          .describe(
            'Prometheus only: "range" (default) evaluates across the window at stepSeconds; "instant" returns one ' +
              'value per series at the window end. Not accepted for InfluxQL',
          ),
        stepSeconds: z
          .number()
          .int()
          .positive()
          .max(MAX_STEP_SECONDS)
          .optional()
          .describe(
            'Prometheus range queries: the evaluation step, in seconds. Required — deliberately never inferred, ' +
              'since it changes the answer of every range-vector function. Match the scrape interval (e.g. 15 or ' +
              '60) to measure real samples. Not accepted for InfluxQL or instant queries',
          ),
        includePoints: z
          .boolean()
          .optional()
          .default(true)
          .describe('Set false to return only per-series stats and the Explore URL, omitting raw points'),
        connection: z.string().optional().describe('Which Grafana connection to use; omit when only one is configured'),
      },
      annotations: { readOnlyHint: true, title: 'Execute an ad-hoc query' },
    },
    async ({ query, datasourceUid, fromMs, toMs, queryType, stepSeconds, includePoints, connection }) => {
      // One mutable audit payload, filled in as the call progresses.
      // appendAuditRecord serializes it only after this callback settles
      // (success or throw), so a URL attached mid-flight still lands in
      // audit.jsonl — which is what makes a *refused* or failing query
      // reproducible too, and those are the ones an auditor most wants to
      // replay. withAudit logs argsSummary, never the result, so this is the
      // only channel that survives a throw.
      const auditArgs: Record<string, unknown> = {
        query,
        datasourceUid,
        fromMs,
        toMs,
        queryType,
        stepSeconds,
        connection,
      };
      let exploreUrl: string | undefined;
      try {
        return await withAudit(
          'execute_adhoc_query',
          auditArgs,
          config,
          async () => {
            const { client, connectionId } = resolveToolClient(registry, { connection });
            const authorizedTypes = registry.adhocDatasourceTypes(connectionId);
            const datasource = await resolveAuthorizedDatasource(client, datasourceUid, authorizedTypes);
            const dialect = GUARDABLE_TYPES[datasource.type]!;

            // Classify before building the URL, so the link can replay the text
            // that actually ran. The guard returns the *scanned* statement
            // (InfluxQL collapses comments to separators; PromQL never rewrites
            // at all), and that — not `query` — is what gets executed below, so
            // a URL built from `query` would not be the "re-runs exactly that
            // query" link docs/TOOLS.md promises.
            const verdict = dialect.classify(query);

            // Prepared before the URL is built, because the pane needs the
            // same step and mode the query ran with — a link that replays a
            // range query without its step can disagree with the numbers
            // returned. Only on the allowed path: a refused query has no shape
            // to prepare, so its dialect parameters go unchecked and the guard's
            // reason (the thing that has to be fixed first) is what comes back.
            const prepared = verdict.allowed
              ? dialect.prepare(verdict.statement, { fromMs, toMs, queryType, stepSeconds }, config)
              : undefined;

            const baseUrl = registry.list().find((c) => c.id === connectionId)?.url;
            if (baseUrl) {
              exploreUrl = buildExploreUrl(baseUrl, {
                datasourceUid: datasource.uid,
                datasourceType: datasource.type,
                // Success path: replay exactly what ran. Refusal path: replay
                // what was *asked*, since that's the thing an auditor wants to
                // reproduce — the scanned form of a refused query may not even
                // be valid on its own.
                query: verdict.allowed ? verdict.statement : query,
                fromMs,
                toMs,
                ...(prepared?.explore ?? {}),
              });
              auditArgs.exploreUrl = exploreUrl;
            }

            if (!verdict.allowed) {
              // Naming the dialect makes the dispatch visible: an agent that
              // meant PromQL and hit an InfluxQL refusal has picked the wrong
              // datasource, which the reason text alone wouldn't reveal.
              throw new Error(`${dialect.language} query refused: ${verdict.reason}`);
            }

            const target: ResolvedTarget = {
              refId: 'A',
              datasourceUid: datasource.uid,
              raw: { refId: 'A', ...prepared!.raw },
            };
            // executeQueryWindow applies enforceWindowLimit and
            // clampMaxDataPoints itself, so an ad-hoc window is bounded by
            // exactly the same caps a replayed panel window is.
            const executed = await executeQueryWindow(
              client,
              [target],
              { label: 'adhoc', fromMs, toMs },
              config,
            );

            const clamped = clampSeriesPoints(executed.series, config);
            const result = {
              connection: connectionId,
              datasource: { uid: datasource.uid, type: datasource.type },
              // Marked on the result, not just documented: analysis/summarize.ts
              // is deterministic on the assumption its inputs were
              // human-authored, so anything built on this has to be able to say
              // where it came from.
              provenance: 'adhoc' as const,
              query: verdict.statement,
              window: { fromMs, toMs },
              ...prepared!.resultFields,
              ...(prepared!.requestedStepMs !== undefined
                ? reportedStep(executed.series, prepared!.requestedStepMs)
                : {}),
              exploreUrl,
              series: clamped.map((s, i) => {
                const { points, ...rest } = s;
                return {
                  ...rest,
                  ...(includePoints ? { points } : {}),
                  stats: computeStats(executed.series[i]!.points),
                };
              }),
              errors: executed.errors,
            };
            return {
              content: [
                {
                  type: 'text' as const,
                  // exploreUrl is exempt from the customer-identifier patterns:
                  // redactString rewrites inside strings, so a match would
                  // return a broken link rather than a masked one — and it
                  // would mask nothing the model doesn't have, since the model
                  // wrote this query. See security/redact.ts's RedactOptions.
                  text: JSON.stringify(redact(result, config.redactionPatterns, { exempt: ['exploreUrl'] })),
                },
              ],
            };
          },
        );
      } catch (err) {
        // Deliberately not passing exploreUrl through here: toolErrorResult
        // labels its url "Dashboard/panel" (wrong for an Explore link) and
        // redacts it without the exemption, so a matched pattern would hand back
        // a mangled URL. The clean one is already in the audit record above.
        return toolErrorResult(err, config);
      }
    },
  );
}
