import type { DashboardJson, DatasourceRef, Panel, PanelTarget } from '../grafana/types.js';

export interface ResolvedTarget {
  refId: string;
  datasourceUid?: string;
  raw: PanelTarget;
}

export interface ResolvedPanel {
  panelId: number;
  title?: string;
  type?: string;
  targets: ResolvedTarget[];
}

/** Row panels nest their contents under `panels`; flatten to queryable leaves. */
export function flattenPanels(panels: Panel[]): Panel[] {
  const out: Panel[] = [];
  for (const p of panels) {
    if (p.panels && p.panels.length > 0) {
      out.push(...flattenPanels(p.panels));
    } else {
      out.push(p);
    }
  }
  return out;
}

function datasourceRefToUid(ref: DatasourceRef | string | null | undefined): string | undefined {
  if (!ref) return undefined;
  if (typeof ref === 'string') {
    // "-- Mixed --" means each target carries its own datasource; a legacy
    // name-based string ref can't be resolved to a uid without a name->uid
    // lookup, which callers can do via GrafanaClient.listDatasources().
    if (ref === '-- Mixed --') return undefined;
    return ref;
  }
  return ref.uid;
}

/** Extracts every queryable panel (has targets) with its datasource resolved per-target. */
export function resolvePanelQueries(dashboard: DashboardJson): ResolvedPanel[] {
  return flattenPanels(dashboard.panels ?? [])
    .filter((p): p is Panel & { targets: PanelTarget[] } => Boolean(p.targets?.length))
    .map((p) => {
      const panelDsUid = datasourceRefToUid(p.datasource);
      return {
        panelId: p.id,
        title: p.title,
        type: p.type,
        targets: p.targets.map((t) => ({
          refId: t.refId,
          datasourceUid: datasourceRefToUid(t.datasource) ?? panelDsUid,
          raw: t,
        })),
      };
    });
}

export function findPanel(dashboard: DashboardJson, panelId: number): ResolvedPanel | undefined {
  return resolvePanelQueries(dashboard).find((p) => p.panelId === panelId);
}
