import type { Config } from '../config.js';
import type { GrafanaClient } from '../grafana/client.js';
import type { RulerRuleGroup } from '../grafana/types.js';
import { resolvePanelQueries } from '../dashboards/panelQueries.js';
import { extractQueryInfo } from './extract.js';
import { isStale, loadIndex, saveIndex, type AlertRuleRef, type MetricIndex } from './store.js';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * A legacy string datasource ref can be a Grafana template variable
 * ($datasource, ${datasource}, $sysops_griffin_datasource, ...) rather than a
 * literal datasource name — panelQueries.ts passes these through unresolved,
 * and they'll never match a real UID, so treating them as "broken" is a
 * false positive (confirmed against real data: this was the overwhelming
 * majority of a many-thousands-per-connection brokenDatasources count). A
 * plain literal name (e.g. "Griffin-ELB") is left flagged — that one could
 * genuinely be a renamed/deleted datasource, which we can't tell apart from
 * a template variable without also doing a name->uid lookup.
 */
function isTemplateVariableRef(ref: string): boolean {
  return ref.startsWith('$');
}

/**
 * Builds a dashboardUid|panelId -> alert rules lookup by crawling every
 * Grafana-managed alert rule and reading its __dashboardUid__/__panelId__
 * annotations — the same annotations a single rule fetch exposes
 * (alerts/ingest.ts), just for every rule at once. A rule with no such
 * annotations isn't linked to a specific panel and is skipped here (not an
 * error — plenty of rules are label-based with no dashboard link at all).
 */
function indexAlertRulesByPanel(ruleGroupsByFolder: Record<string, RulerRuleGroup[]>): Map<string, AlertRuleRef[]> {
  const byPanel = new Map<string, AlertRuleRef[]>();
  for (const groups of Object.values(ruleGroupsByFolder)) {
    for (const group of groups) {
      for (const { grafana_alert: rule } of group.rules) {
        const dashboardUid = rule.annotations?.__dashboardUid__;
        const panelIdStr = rule.annotations?.__panelId__;
        if (!dashboardUid || !panelIdStr) continue;
        const key = `${dashboardUid}|${panelIdStr}`;
        const list = byPanel.get(key) ?? [];
        list.push({ uid: rule.uid, title: rule.title, labels: rule.labels ?? {}, folderUid: group.folderUid });
        byPanel.set(key, list);
      }
    }
  }
  return byPanel;
}

/**
 * Crawls every dashboard's panels and builds a metric/measurement -> dashboard
 * reverse index, a list of panels pointing at a datasource uid that no
 * longer exists, and a list of panels a real alert rule is wired to — the
 * strongest available signal for which dashboards are actually relied on
 * versus a test/scratch/deprecated one that merely matches a search term.
 * This is what find_related_dashboards searches against.
 */
export async function buildMetricIndex(client: GrafanaClient): Promise<MetricIndex> {
  const [summaries, datasources, ruleGroupsByFolder] = await Promise.all([
    client.searchDashboards({ limit: 5000 }),
    client.listDatasources(),
    // Alert-rule access is an enhancement (surfacing which panels are
    // actually relied on), not a requirement — some tokens/older Grafana
    // versions won't have the ruler API available, and that shouldn't break
    // dashboard/metric indexing, which worked fine without this before.
    client.getRuleGroups().catch(() => ({})),
  ]);
  const knownDsUids = new Set(datasources.map((d) => d.uid));
  const alertRulesByPanel = indexAlertRulesByPanel(ruleGroupsByFolder);

  const index: MetricIndex = {
    builtAt: new Date().toISOString(),
    dashboardsScanned: 0,
    entriesByMetric: {},
    brokenDatasources: [],
    alertBackedPanels: [],
  };

  const dashboardResults = await Promise.allSettled(
    summaries
      .filter((s) => s.type === 'dash-db')
      .map((s) => client.getDashboard(s.uid)),
  );

  for (const result of dashboardResults) {
    if (result.status !== 'fulfilled') continue;
    const dashboard = result.value.dashboard;
    index.dashboardsScanned++;

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
          !isTemplateVariableRef(target.datasourceUid)
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
  }

  return index;
}

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
  const fresh = await buildMetricIndex(client);
  await saveIndex(fresh, config, connectionId);
  return fresh;
}
