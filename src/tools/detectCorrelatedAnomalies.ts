import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import { computeWindows } from '../query/windows.js';
import { executeQueryWindow, type QuerySeries } from '../query/executor.js';
import { computeStats, detectOnset } from '../analysis/baseline.js';
import { rankCorrelatedAnomalies, type CorrelationCandidateInput } from '../analysis/correlation.js';
import { getCachedIndexIfFresh, getOrBuildIndex } from '../index-builder/metricIndex.js';
import type { MetricIndex } from '../index-builder/store.js';
import { extractQueryInfo } from '../index-builder/extract.js';
import { dashboardUrlFor, epochMsSchema, recordActivity, resolvePanelForWindow, resolveToolClient, toolErrorResult, windowSizeWarning } from './shared.js';
import { materializeVariables } from './liveVariables.js';
import { resolveProductContext } from '../knowledge/lookup.js';
import { extractRelatedDashboardUids } from '../knowledge/relatedDashboards.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

function seriesKey(series: QuerySeries): string {
  const labelStr = Object.entries(series.labels).sort().map(([k, v]) => `${k}=${v}`).join(',');
  return `${series.refId}|${labelStr}`;
}

interface CandidateRef {
  dashboardUid: string;
  panelId: number;
  connectionId: string;
}

const SCOPE_ORDER = ['product', 'connection', 'all-connections'] as const;
type Scope = (typeof SCOPE_ORDER)[number];

function tierOf(ref: CandidateRef, primaryConnectionId: string, productDashboardUids: Set<string>): Scope {
  if (ref.connectionId === primaryConnectionId && productDashboardUids.has(ref.dashboardUid)) return 'product';
  if (ref.connectionId === primaryConnectionId) return 'connection';
  return 'all-connections';
}

export function registerDetectCorrelatedAnomalies(server: McpServer, { registry, config, activityLog }: ToolContext): void {
  server.registerTool(
    'detect_correlated_anomalies',
    {
      title: 'Detect correlated anomalies',
      description:
        'Compares the alerting panel against other panels (explicitly given, or auto-discovered from the metric ' +
        'reverse index via find_related_dashboards) over the same incident window. Ranks candidates by deviation ' +
        'strength, label overlap with the primary alert, and how closely their anomaly onset lines up with the ' +
        'primary\'s — a triage heuristic for blast radius, not a statistical proof of causation. When ' +
        'auto-discovering (candidates omitted), checks one "scope" tier per call, narrowest first: "product" (the ' +
        'primary dashboard, plus its own ops/SLI dashboards and declared dependencies from its Timebuddy knowledge ' +
        'panel when one is published for this alert — falls back to just the primary dashboard alone when none ' +
        'is), then "connection" (everything else on the same Grafana connection), then "all-connections" (every ' +
        'other configured connection) — call narrower scopes first, report what each found, and only widen when ' +
        'warranted (nothing correlated yet, or the blast radius is still unclear); the response\'s "nextScope"/' +
        '"nextScopeCandidateCount" tells you whether widening further would even find anything - each connection\'s ' +
        'metric index is crawled fresh from every dashboard the first time (or once its cache goes stale), which ' +
        'can take minutes on a large Grafana estate, so this call only ever builds the index(es) the requested ' +
        '"scope" actually needs; "nextScopeCandidateCount" is omitted (not guessed) when the next tier would need ' +
        'a connection whose index isn\'t already built and cached - call that wider scope directly to find out. ' +
        'A "containmentCheckIncomplete": true (with a "containmentHint") is returned whenever a "product"-scope call ' +
        'still has unchecked panels on the same connection (i.e. other products in this region) - treat it as a hard ' +
        'signal that you have NOT yet established blast radius and must re-run with "scope": "connection" before ' +
        'reporting the incident as contained; finding correlated panels within "product" scope only shows the ' +
        'product itself moved, never that nothing else did. ' +
        'Pass an explicit "candidates" array to bypass scoping and check exactly those panels in one call instead. A "$__all" ' +
        'selection on the primary panel\'s own variables is best-effort live-resolved (e.g. an InfluxQL "SHOW TAG ' +
        'VALUES" query variable); when that can\'t be done it falls back to matching everything and the variable ' +
        'name is listed in the top-level "unresolvedAllVariables" (omitted when empty) — candidate panels are ' +
        'unaffected, since those already use each dashboard\'s own saved current values.',
      inputSchema: {
        primaryDashboardUid: z.string(),
        primaryPanelId: z.number(),
        primaryPanelTitle: z.string().optional().describe('Exact panel title — required only when primaryPanelId is ambiguous (multiple panels sharing one id, seen on some provisioned dashboards); the error message lists the candidates when this happens'),
        startsAtMs: epochMsSchema.describe('Incident start — epoch ms or an ISO 8601 date/time'),
        endsAtMs: epochMsSchema.optional().describe('Incident end — epoch ms or ISO 8601'),
        primaryLabels: z.record(z.string(), z.string()).optional().describe('Alert labels, used for relevance ranking'),
        candidates: z
          .array(z.object({ dashboardUid: z.string(), panelId: z.number(), connectionId: z.string().optional() }))
          .optional()
          .describe('Panels to check; omit to auto-discover via the metric reverse index, staged by "scope". connectionId defaults to the primary panel\'s connection.'),
        scope: z
          .enum(SCOPE_ORDER)
          .optional()
          .default('product')
          .describe(
            'Which auto-discovery tier to check this call, narrowest first: "product" (default), "connection", ' +
              'then "all-connections". Ignored when "candidates" is given explicitly.',
          ),
        variableOverrides: z.record(z.string(), z.array(z.string())).optional(),
        limit: z.number().optional().default(10),
        connection: z.string().optional().describe('Connection id for the primary panel, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'Detect correlated anomalies' },
    },
    async ({ primaryDashboardUid, primaryPanelId, primaryPanelTitle, startsAtMs, endsAtMs, primaryLabels, candidates, scope, variableOverrides, limit, connection }) => {
      let primaryConnectionId: string | undefined;
      try {
        return await withAudit(
          'detect_correlated_anomalies',
          { primaryDashboardUid, primaryPanelId, startsAtMs, endsAtMs },
          config,
          async () => {
            const { client: primaryClient, connectionId } = resolveToolClient(registry, { connection });
            primaryConnectionId = connectionId;
            const windowSet = computeWindows({ startsAtMs, endsAtMs, controlOffsets: [] });
            // Fail fast, before running a single Grafana query, rather than
            // executing an accidentally-huge window across every candidate —
            // see execute_query_window for why. Only fires when endsAtMs was
            // omitted.
            const sizeWarning = windowSizeWarning(startsAtMs, endsAtMs, windowSet.incident.toMs);
            if (sizeWarning) {
              throw new Error(`${sizeWarning} No query was executed.`);
            }
            const overrides = variableOverrides ?? {};

            // Live-resolve any "$__all" query-type variable once, using the incident
            // window — same rationale as execute_query_window: a baseline window
            // resolving to a different value list than the incident window would
            // break the comparison. Scoped to the primary panel only; auto-discovered
            // candidate panels below already use {} overrides / saved current values.
            const { dashboard: primaryDashboard, meta: primaryMeta } = await primaryClient.getDashboard(primaryDashboardUid);
            const primaryVariables = primaryDashboard.templating?.list ?? [];
            const { overrides: resolvedOverrides, unresolvedAllVariables } = await materializeVariables(
              primaryClient,
              primaryVariables,
              overrides,
              windowSet.incident,
            );

            const primaryResolved = await resolvePanelForWindow(
              primaryClient,
              primaryDashboardUid,
              primaryPanelId,
              resolvedOverrides,
              windowSet.incident,
              config.maxDataPoints,
              primaryPanelTitle,
            );
            const primaryIncident = await executeQueryWindow(primaryClient, primaryResolved.targets, windowSet.incident, config);
            const primaryPreWindowResolved = await resolvePanelForWindow(
              primaryClient,
              primaryDashboardUid,
              primaryPanelId,
              resolvedOverrides,
              windowSet.preWindow,
              config.maxDataPoints,
              primaryPanelTitle,
            );
            const primaryPreWindow = await executeQueryWindow(primaryClient, primaryPreWindowResolved.targets, windowSet.preWindow, config);

            const primaryOnsets = primaryIncident.series
              .map((s) => {
                const baseline = computeStats(
                  primaryPreWindow.series.find((p) => seriesKey(p) === seriesKey(s))?.points ?? [],
                );
                return detectOnset(s.points, baseline);
              })
              .filter((t): t is number => t !== undefined);
            const primaryOnsetMs = primaryOnsets.length ? Math.min(...primaryOnsets) : undefined;

            const primaryUrl = dashboardUrlFor(registry, connectionId, primaryDashboardUid, {
              panelId: primaryPanelId,
              fromMs: windowSet.incident.fromMs,
              toMs: windowSet.incident.toMs,
            });
            recordActivity(registry, activityLog, {
              toolName: 'detect_correlated_anomalies',
              connectionId,
              dashboardUid: primaryDashboardUid,
              dashboardTitle: primaryDashboard.title,
              panelId: primaryPanelId,
              panelTitle: primaryResolved.panel.title,
              url: primaryUrl,
            });

            const effectiveLabels = primaryLabels ?? {};

            let candidateRefs: CandidateRef[];
            let scopeInfo:
              | {
                  scope: Scope;
                  productScope: { dashboardUids: string[]; source: 'knowledge-dependencies' | 'same-dashboard-only' };
                  nextScope?: Scope;
                  nextScopeCandidateCount?: number;
                  containmentCheckIncomplete?: boolean;
                  containmentHint?: string;
                }
              | undefined;
            if (candidates) {
              candidateRefs = candidates.map((c) => ({ ...c, connectionId: c.connectionId ?? connectionId }));
            } else {
              // Resolve the "product" tier's dashboard set: this alert's own
              // Timebuddy knowledge panel (when one is published) declares its
              // own ops/SLI dashboards plus explicit dependencies (e.g. MDS's
              // compute/blockstorage/gage/iam/hermes) — the most accurate
              // available signal for "what belongs to this product," far
              // better than guessing from folder structure (an alerting/SLI
              // dashboard is often filed in a folder shared by many unrelated
              // products). Falls back to just the primary dashboard alone
              // when nothing's published for this alert.
              const productDashboardUids = new Set<string>([primaryDashboardUid]);
              let productScopeSource: 'knowledge-dependencies' | 'same-dashboard-only' = 'same-dashboard-only';
              try {
                const candidateKeys = [...(primaryDashboard.tags ?? []), ...Object.values(effectiveLabels)];
                const knowledge = candidateKeys.length
                  ? await resolveProductContext(primaryClient, config, connectionId, { startFolderUid: primaryMeta.folderUid, candidateKeys })
                  : undefined;
                if (knowledge) {
                  const related = extractRelatedDashboardUids(knowledge.json);
                  if (related.length) productScopeSource = 'knowledge-dependencies';
                  for (const uid of related) productDashboardUids.add(uid);
                }
              } catch {
                // Best-effort scoping enhancement — a lookup failure just
                // leaves the product tier at its same-dashboard-only fallback,
                // same as "nothing published for this alert".
              }

              const metricNames = new Set(
                primaryResolved.panel.targets.flatMap((t) => extractQueryInfo(t.raw).metricNames),
              );
              const seen = new Set<string>();
              const allCandidateRefs: CandidateRef[] = [];

              const requestedScope = scope ?? 'product';
              const nextScope = SCOPE_ORDER[SCOPE_ORDER.indexOf(requestedScope) + 1];
              // The "product"/"connection" tiers only ever draw candidates from the primary
              // connection's own index - only "all-connections" needs every configured
              // connection's index, which means a full dashboard crawl per connection whose
              // cache is missing/stale (confirmed in practice: ~13 minutes across 7
              // connections/600-860 dashboards each). Building all of them up front made every
              // narrow-scope call pay that cost regardless of what was actually asked for.
              const otherConnections = registry.list().filter((c) => c.id !== connectionId);
              const indexByConnection = new Map<string, MetricIndex>();
              indexByConnection.set(connectionId, await getOrBuildIndex(registry.get(connectionId), config, connectionId, {}));

              let haveAllOtherConnections = true;
              if (requestedScope === 'all-connections') {
                const rest = await Promise.allSettled(
                  otherConnections.map(async (conn) => ({ connectionId: conn.id, index: await getOrBuildIndex(registry.get(conn.id), config, conn.id, {}) })),
                );
                for (const outcome of rest) {
                  if (outcome.status === 'fulfilled') indexByConnection.set(outcome.value.connectionId, outcome.value.index);
                  else haveAllOtherConnections = false;
                }
              } else if (nextScope === 'all-connections') {
                // Only needed to report nextScopeCandidateCount below - use whatever's already
                // cached and fresh, never force a rebuild just to populate a hint field.
                const rest = await Promise.allSettled(
                  otherConnections.map(async (conn) => ({ connectionId: conn.id, index: await getCachedIndexIfFresh(config, conn.id) })),
                );
                for (const outcome of rest) {
                  if (outcome.status === 'fulfilled' && outcome.value.index) indexByConnection.set(outcome.value.connectionId, outcome.value.index);
                  else haveAllOtherConnections = false;
                }
              }

              for (const [entryConnectionId, index] of indexByConnection) {
                for (const metric of metricNames) {
                  for (const entry of index.entriesByMetric[metric] ?? []) {
                    if (
                      entryConnectionId === connectionId &&
                      entry.dashboardUid === primaryDashboardUid &&
                      entry.panelId === primaryPanelId
                    ) {
                      continue;
                    }
                    const key = `${entryConnectionId}|${entry.dashboardUid}|${entry.panelId}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    allCandidateRefs.push({ dashboardUid: entry.dashboardUid, panelId: entry.panelId, connectionId: entryConnectionId });
                  }
                }
              }

              const tiered: Record<Scope, CandidateRef[]> = { product: [], connection: [], 'all-connections': [] };
              for (const ref of allCandidateRefs) tiered[tierOf(ref, connectionId, productDashboardUids)].push(ref);

              candidateRefs = tiered[requestedScope].slice(0, Math.max(limit! * 3, 15));

              // "product" scope alone can never establish blast-radius containment: it only ever
              // looks at this one product's own dashboards (and, when no knowledge is published,
              // just the primary dashboard itself). If there are other panels on this same
              // connection - i.e. other products in this region/estate - that haven't been checked
              // yet, say so explicitly so a "product scope was clean" result isn't misread as "the
              // blast radius is contained." The primary connection's index is always built here, so
              // the "connection" tier's count is always known at "product" scope (unlike the
              // "all-connections" count, which we deliberately don't force a crawl for above). This
              // is the data-side backstop for the same widen-before-claiming-containment rule the
              // investigate skill spells out in prose.
              const containmentCheckIncomplete = requestedScope === 'product' && tiered.connection.length > 0;
              scopeInfo = {
                scope: requestedScope,
                productScope: { dashboardUids: [...productDashboardUids], source: productScopeSource },
                // Omit nextScopeCandidateCount rather than report an undercount when widening to
                // "all-connections" and some other connection's cache wasn't already fresh (see
                // above - we don't force a rebuild just to fill in this hint).
                ...(nextScope && haveAllOtherConnections ? { nextScope, nextScopeCandidateCount: tiered[nextScope].length } : {}),
                ...(nextScope && !haveAllOtherConnections ? { nextScope } : {}),
                ...(containmentCheckIncomplete
                  ? {
                      containmentCheckIncomplete: true,
                      containmentHint:
                        'Only "product" scope has been checked' +
                        (productScopeSource === 'same-dashboard-only'
                          ? ' and no Timebuddy knowledge is published for this alert, so that was just the primary dashboard itself'
                          : '') +
                        `; ${tiered.connection.length} other panel(s) on this same connection (other products in this ` +
                        'region/estate) have not been checked. Do not report the blast radius as contained until you ' +
                        're-run with scope:"connection".',
                    }
                  : {}),
              };
            }

            const candidateInputs: (CorrelationCandidateInput & { connectionId: string })[] = [];
            const settled = await Promise.allSettled(
              candidateRefs.map(async (ref) => {
                const client = registry.get(ref.connectionId);
                const incidentResolved = await resolvePanelForWindow(client, ref.dashboardUid, ref.panelId, {}, windowSet.incident, config.maxDataPoints);
                const incidentResult = await executeQueryWindow(client, incidentResolved.targets, windowSet.incident, config);
                const preResolved = await resolvePanelForWindow(client, ref.dashboardUid, ref.panelId, {}, windowSet.preWindow, config.maxDataPoints);
                const preResult = await executeQueryWindow(client, preResolved.targets, windowSet.preWindow, config);
                return { ref, dashboard: incidentResolved.dashboard, panel: incidentResolved.panel, incidentResult, preResult };
              }),
            );

            for (const outcome of settled) {
              if (outcome.status !== 'fulfilled') continue;
              const { ref, dashboard, panel, incidentResult, preResult } = outcome.value;
              recordActivity(registry, activityLog, {
                toolName: 'detect_correlated_anomalies',
                connectionId: ref.connectionId,
                dashboardUid: ref.dashboardUid,
                dashboardTitle: dashboard.title,
                panelId: ref.panelId,
                panelTitle: panel.title,
                url: dashboardUrlFor(registry, ref.connectionId, ref.dashboardUid, {
                  panelId: ref.panelId,
                  fromMs: windowSet.incident.fromMs,
                  toMs: windowSet.incident.toMs,
                }),
              });
              for (const series of incidentResult.series) {
                const preSeries = preResult.series.find((s) => seriesKey(s) === seriesKey(series));
                candidateInputs.push({
                  dashboardUid: ref.dashboardUid,
                  dashboardTitle: dashboard.title,
                  panelId: ref.panelId,
                  panelTitle: panel.title,
                  labels: series.labels,
                  incidentPoints: series.points,
                  preWindowPoints: preSeries?.points ?? [],
                  connectionId: ref.connectionId,
                });
              }
            }

            const ranked = rankCorrelatedAnomalies(candidateInputs, effectiveLabels, primaryOnsetMs).map((r) => ({
              ...r,
              url: r.connectionId
                ? dashboardUrlFor(registry, r.connectionId, r.dashboardUid, {
                    panelId: r.panelId,
                    fromMs: windowSet.incident.fromMs,
                    toMs: windowSet.incident.toMs,
                  })
                : undefined,
            }));
            const result = {
              primaryConnectionId: connectionId,
              primaryUrl,
              primaryOnsetMs,
              ...(scopeInfo ?? {}),
              candidatesChecked: candidateRefs.length,
              correlated: ranked.slice(0, limit),
              ...(unresolvedAllVariables.length > 0 ? { unresolvedAllVariables } : {}),
            };
            return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
          },
        );
      } catch (err) {
        const url = primaryConnectionId
          ? dashboardUrlFor(registry, primaryConnectionId, primaryDashboardUid, { panelId: primaryPanelId })
          : undefined;
        return toolErrorResult(err, config, url);
      }
    },
  );
}
