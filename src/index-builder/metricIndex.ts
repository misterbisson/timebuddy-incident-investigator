import type { Config } from '../config.js';
import type { GrafanaClient } from '../grafana/client.js';
import { resolvePanelQueries } from '../dashboards/panelQueries.js';
import { extractQueryInfo } from './extract.js';
import { isStale, loadIndex, saveIndex, type MetricIndex } from './store.js';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Crawls every dashboard's panels and builds a metric/measurement -> dashboard
 * reverse index, plus a list of panels pointing at a datasource uid that no
 * longer exists. This is the "which dashboards use this metric" lookup Story
 * 5 asks for, and the input find_related_dashboards searches against.
 */
export async function buildMetricIndex(client: GrafanaClient): Promise<MetricIndex> {
  const [summaries, datasources] = await Promise.all([
    client.searchDashboards({ limit: 5000 }),
    client.listDatasources(),
  ]);
  const knownDsUids = new Set(datasources.map((d) => d.uid));

  const index: MetricIndex = {
    builtAt: new Date().toISOString(),
    dashboardsScanned: 0,
    entriesByMetric: {},
    brokenDatasources: [],
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
      for (const target of panel.targets) {
        if (target.datasourceUid && !knownDsUids.has(target.datasourceUid)) {
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
  opts: { force?: boolean; ttlMs?: number } = {},
): Promise<MetricIndex> {
  if (!opts.force) {
    const cached = await loadIndex(config);
    if (cached && !isStale(cached, opts.ttlMs ?? DEFAULT_TTL_MS)) return cached;
  }
  const fresh = await buildMetricIndex(client);
  await saveIndex(fresh, config);
  return fresh;
}
