import type { Config } from '../config.js';
import type { GrafanaClient } from '../grafana/client.js';
import type { DashboardGetResponse, RulerRuleGroup, SearchResultItem } from '../grafana/types.js';
import { resolvePanelQueries } from '../dashboards/panelQueries.js';
import { extractQueryInfo } from './extract.js';
import { CURRENT_SCHEMA_VERSION, isStale, loadIndex, saveIndex, type AlertRuleRef, type MetricIndex } from './store.js';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Grafana's /api/search caps a single response at 5000 rows regardless of the
 * `limit` sent, so the crawl pages through at this size. The previous code
 * asked for limit:5000 once and silently treated the first page as the whole
 * estate — an estate with more dashboards than this was indexed only in part,
 * with nothing to signal it.
 */
export const SEARCH_PAGE_SIZE = 5000;

/** Fallback fetch concurrency when no Config is supplied (tests). Real callers pass config.maxConcurrency. */
const DEFAULT_CRAWL_CONCURRENCY = 4;

/**
 * Grafana's own special pseudo-datasource references — never real
 * datasources, so never "broken": __expr__ (the Expression pseudo-datasource,
 * for panels that do math on other queries rather than querying anything)
 * and -- Dashboard --/-- Grafana -- (reuse this dashboard's own annotations /
 * built-in test data, respectively). -- Mixed -- is handled separately in
 * panelQueries.ts (resolves to undefined there, never reaches this check).
 */
const GRAFANA_PSEUDO_DATASOURCE_REFS = new Set(['__expr__', '-- Dashboard --', '-- Grafana --']);

/**
 * A legacy string datasource ref can be a Grafana template variable
 * ($datasource, ${datasource}, $sysops_griffin_datasource, ...) rather than a
 * literal datasource name — panelQueries.ts passes these through unresolved,
 * and they'll never match a real UID, so treating them as "broken" is a
 * false positive (confirmed against real data: this and the pseudo-datasource
 * refs above were the overwhelming majority of a many-thousands-per-connection
 * brokenDatasources count). A plain literal name (e.g. "Griffin-ELB") is left
 * flagged — that one could genuinely be a renamed/deleted datasource, which
 * we can't tell apart from a template variable without also doing a
 * name->uid lookup.
 */
function isNonQueryableDatasourceRef(ref: string): boolean {
  return ref.startsWith('$') || GRAFANA_PSEUDO_DATASOURCE_REFS.has(ref);
}

/**
 * Builds a dashboardUid|panelId -> alert rules lookup by crawling every
 * Grafana-managed alert rule and reading its __dashboardUid__/__panelId__
 * annotations — the same annotations a single rule fetch exposes
 * (alerts/ingest.ts), just for every rule at once. A rule with no such
 * annotations isn't linked to a specific panel and is skipped here (not an
 * error — plenty of rules are label-based with no dashboard link at all).
 *
 * annotations/labels come from the rule wrapper, not from grafana_alert
 * itself — see RulerRuleGroup's doc comment; getting this backwards means
 * every rule silently reads as unlinked, with no error to notice it by.
 */
function indexAlertRulesByPanel(ruleGroupsByFolder: Record<string, RulerRuleGroup[]>): Map<string, AlertRuleRef[]> {
  const byPanel = new Map<string, AlertRuleRef[]>();
  for (const groups of Object.values(ruleGroupsByFolder)) {
    for (const group of groups) {
      for (const { grafana_alert: rule, annotations, labels } of group.rules) {
        const dashboardUid = annotations?.__dashboardUid__;
        const panelIdStr = annotations?.__panelId__;
        if (!dashboardUid || !panelIdStr) continue;
        const key = `${dashboardUid}|${panelIdStr}`;
        const list = byPanel.get(key) ?? [];
        list.push({ uid: rule.uid, title: rule.title, labels: labels ?? {}, folderUid: group.folderUid });
        byPanel.set(key, list);
      }
    }
  }
  return byPanel;
}

/**
 * Pages through /api/search to enumerate every dashboard, rather than taking
 * a single capped page. Dedups by uid and stops when a page returns no new
 * uid — that second condition is the guard against a Grafana that ignores the
 * `page` param and would otherwise return the same first page forever.
 */
async function discoverDashboards(client: GrafanaClient): Promise<SearchResultItem[]> {
  const all: SearchResultItem[] = [];
  const seen = new Set<string>();
  let page = 1;
  for (;;) {
    const batch = await client.searchDashboards({ limit: SEARCH_PAGE_SIZE, page });
    let fresh = 0;
    for (const s of batch) {
      if (s.type !== 'dash-db' || seen.has(s.uid)) continue;
      seen.add(s.uid);
      all.push(s);
      fresh++;
    }
    // A short page is the last page (real Grafana); no fresh uids means the
    // server is repeating pages and we've already seen everything it has.
    if (batch.length < SEARCH_PAGE_SIZE || fresh === 0) break;
    page++;
  }
  return all;
}

/**
 * Fetches each dashboard and hands it to `fold` as soon as it resolves, with
 * at most `concurrency` fetches in flight and — crucially — at most that many
 * DashboardGetResponse objects retained at once. The previous code built one
 * getDashboard promise per dashboard up front and held every resolved
 * response alive until the last settled, so on a multi-thousand-dashboard
 * estate it kept every full dashboard document in memory simultaneously.
 *
 * A single dashboard failing to fetch is skipped, not fatal — the same
 * tolerance the previous Promise.allSettled had. `fold` runs synchronously
 * between fetches, so it never races another fold on the shared index.
 */
async function crawlDashboards(
  client: GrafanaClient,
  uids: string[],
  concurrency: number,
  fold: (response: DashboardGetResponse) => void,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= uids.length) return;
      let response: DashboardGetResponse;
      try {
        response = await client.getDashboard(uids[i]!);
      } catch {
        continue;
      }
      fold(response);
    }
  };
  const workerCount = Math.max(1, Math.min(concurrency, uids.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
}

/**
 * Crawls every dashboard's panels and builds a metric/measurement -> dashboard
 * reverse index, a list of panels pointing at a datasource uid that no
 * longer exists, and a list of panels a real alert rule is wired to — the
 * strongest available signal for which dashboards are actually relied on
 * versus a test/scratch/deprecated one that merely matches a search term.
 * This is what find_related_dashboards searches against.
 *
 * `config` only supplies the fetch concurrency; it's optional so tests can
 * build an index from a fake client without assembling a whole Config.
 */
export async function buildMetricIndex(client: GrafanaClient, config?: Config): Promise<MetricIndex> {
  const [summaries, datasources] = await Promise.all([
    discoverDashboards(client),
    client.listDatasources(),
  ]);
  const knownDsUids = new Set(datasources.map((d) => d.uid));

  // Alert-rule access is an enhancement (surfacing which panels are actually
  // relied on), not a requirement — some tokens/older Grafana versions won't
  // have the ruler API available, and that shouldn't break dashboard/metric
  // indexing, which worked fine without this before. But silently swallowing
  // the error made a real failure indistinguishable from "there genuinely
  // are no alert rules" — confirmed against a real Grafana estate that
  // showed alertBackedTotal: 0 across ~2,847 dashboards with no way to tell
  // which case it was. Capture and surface it instead of just discarding it.
  let alertRuleAccessError: string | undefined;
  const ruleGroupsByFolder = await client.getRuleGroups().catch((err) => {
    alertRuleAccessError = err instanceof Error ? err.message : String(err);
    return {};
  });
  const alertRulesByPanel = indexAlertRulesByPanel(ruleGroupsByFolder);

  const index: MetricIndex = {
    builtAt: new Date().toISOString(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    dashboardsDiscovered: summaries.length,
    dashboardsScanned: 0,
    entriesByMetric: {},
    brokenDatasources: [],
    alertBackedPanels: [],
    dashboardMeta: {},
    alertRuleAccessError,
  };

  const foldDashboard = ({ dashboard, meta }: DashboardGetResponse): void => {
    index.dashboardsScanned++;

    index.dashboardMeta[dashboard.uid] = {
      title: dashboard.title,
      updatedAt: meta.updated,
      updatedBy: meta.updatedBy,
      createdAt: meta.created,
      createdBy: meta.createdBy,
    };

    for (const panel of resolvePanelQueries(dashboard)) {
      const alertRules = alertRulesByPanel.get(`${dashboard.uid}|${panel.panelId}`);
      if (alertRules) {
        index.alertBackedPanels.push({
          dashboardUid: dashboard.uid,
          dashboardTitle: dashboard.title,
          panelId: panel.panelId,
          panelTitle: panel.title,
          alertRules,
        });
      }

      for (const target of panel.targets) {
        if (
          target.datasourceUid &&
          !knownDsUids.has(target.datasourceUid) &&
          !isNonQueryableDatasourceRef(target.datasourceUid)
        ) {
          index.brokenDatasources.push({
            dashboardUid: dashboard.uid,
            dashboardTitle: dashboard.title,
            panelId: panel.panelId,
            datasourceUid: target.datasourceUid,
          });
        }

        const info = extractQueryInfo(target.raw);
        for (const metric of info.metricNames) {
          const list = (index.entriesByMetric[metric] ??= []);
          const alreadyListed = list.some(
            (e) => e.dashboardUid === dashboard.uid && e.panelId === panel.panelId,
          );
          if (!alreadyListed) {
            list.push({
              dashboardUid: dashboard.uid,
              dashboardTitle: dashboard.title,
              panelId: panel.panelId,
              panelTitle: panel.title,
              datasourceUid: target.datasourceUid,
              labels: info.labels,
            });
          }
        }
      }
    }
  };

  await crawlDashboards(
    client,
    summaries.map((s) => s.uid),
    config?.maxConcurrency ?? DEFAULT_CRAWL_CONCURRENCY,
    foldDashboard,
  );

  return index;
}

/**
 * In-flight crawls keyed by connection id. A crawl takes minutes, and
 * find_related_dashboards / detect_correlated_anomalies are routinely called
 * back-to-back against a cold cache — without this, both would start their
 * own full crawl and then both write the same file. Keyed by connection id
 * (not globally) so two different connections still build in parallel. Keyed
 * on this module's singleton map, which is correct because a connection's
 * GrafanaClient is itself cached one-per-id by the ConnectionRegistry.
 */
const inFlightBuilds = new Map<string, Promise<MetricIndex>>();

/**
 * Returns the cached index if it's fresh enough, otherwise rebuilds and
 * persists it. Keeps this a pull-based refresh (triggered by a tool call)
 * rather than requiring a separate always-running crawler process.
 */
export async function getOrBuildIndex(
  client: GrafanaClient,
  config: Config,
  connectionId: string,
  opts: { force?: boolean; ttlMs?: number } = {},
): Promise<MetricIndex> {
  if (!opts.force) {
    const cached = await loadIndex(config, connectionId);
    if (cached && !isStale(cached, opts.ttlMs ?? DEFAULT_TTL_MS)) return cached;
  }

  // Coalesce onto an already-running crawl for this connection rather than
  // starting a second one. A forced rebuild still joins one in progress —
  // the caller wants a fresh index, and the in-flight build already is one.
  const existing = inFlightBuilds.get(connectionId);
  if (existing) return existing;

  const build = (async () => {
    // A full crawl (searchDashboards + getDashboard per dashboard) confirmed to take on the order
    // of minutes per connection on a real estate (~600-860 dashboards) - without this, a caller has
    // no way to tell "building the index" apart from "hung," since nothing else logs during it.
    console.error(`[metric-index] Building index for connection "${connectionId}" (crawling all dashboards - this can take several minutes)...`);
    const startedAt = Date.now();
    const fresh = await buildMetricIndex(client, config);
    console.error(`[metric-index] Finished "${connectionId}": ${fresh.dashboardsScanned}/${fresh.dashboardsDiscovered ?? fresh.dashboardsScanned} dashboards scanned in ${Date.now() - startedAt}ms.`);
    await saveIndex(fresh, config, connectionId);
    return fresh;
  })();

  inFlightBuilds.set(connectionId, build);
  try {
    return await build;
  } finally {
    inFlightBuilds.delete(connectionId);
  }
}

/** Reads the on-disk cache without ever triggering a rebuild - returns undefined on a cache miss or stale entry rather than paying for a fresh crawl. For best-effort cross-connection hints where forcing a build isn't warranted. */
export async function getCachedIndexIfFresh(config: Config, connectionId: string, ttlMs: number = DEFAULT_TTL_MS): Promise<MetricIndex | undefined> {
  const cached = await loadIndex(config, connectionId);
  if (cached && !isStale(cached, ttlMs)) return cached;
  return undefined;
}
