import type { DashboardJson, DatasourceRef, Panel, PanelTarget } from '../grafana/types.js';

export interface ResolvedTarget {
  refId: string;
  datasourceUid?: string;
  raw: PanelTarget;
}

export interface ResolvedDataLink {
  title?: string;
  /** Raw URL template, e.g. "/d/other-dashboard?var-account_id=${__data.fields[\"Field\"]}&from=${__from}&to=${__to}" — Grafana resolves the ${...} macros client-side on click; this server doesn't (see resolvePanelDataLinks' doc comment for why), so substitute field values from the query result and the window bounds yourself to get a working URL. */
  url: string;
  /** The field this link applies to (from a fieldConfig override matched by field name); undefined if it applies to every field. */
  appliesToField?: string;
}

export interface ResolvedPanel {
  panelId: number;
  title?: string;
  type?: string;
  targets: ResolvedTarget[];
  dataLinks: ResolvedDataLink[];
  /**
   * Set when every target uses Grafana's built-in "-- Dashboard --"
   * pseudo-datasource — the panel id(s) it re-displays an already-computed
   * value from, not itself queryable via /api/ds/query. See
   * DASHBOARD_MIRROR_REF's doc comment.
   */
  mirrorsPanelIds?: number[];
}

/**
 * Grafana's built-in "-- Dashboard --" pseudo-datasource: a stat/gauge panel
 * configured this way doesn't query anything itself — it re-displays another
 * panel's already-computed value client-side (each target carries that
 * source panel's id in its own "panelId" field), a Grafana-UI-only feature
 * with no backend behind it. Replaying it through /api/ds/query always 404s
 * ("data source not found"), which reads like a broken dashboard but isn't —
 * confirmed as a recurring, mechanically-detectable pattern across real
 * dashboards (multiple independent investigations have hit this and had to
 * fetch the raw dashboard JSON to explain it). See also
 * index-builder/metricIndex.ts's GRAFANA_PSEUDO_DATASOURCE_REFS, which
 * excludes the same ref from its "broken datasource" count for the same
 * reason.
 */
const DASHBOARD_MIRROR_REF = '-- Dashboard --';

/**
 * Extracts a panel's configured drill-down links (Grafana calls these "data
 * links") — e.g. a table column's "click to see this account's dashboard"
 * link. These are URL *templates*: Grafana substitutes macros like
 * ${__from}/${__to}/${__data.fields["X"]} client-side when a cell is
 * clicked, using that row's actual field values and the panel's time range.
 * Resolving those macros ourselves would mean re-implementing a fair chunk
 * of Grafana's templating engine (many macro variants: __value.raw/text/
 * numeric, __series.name, __field.name, __data.fields[...], __from/__to,
 * __all_variables, ...) for something the caller can usually do with simple
 * string substitution once they already have the row's field values (from
 * the query result) and the window bounds (already known) — so this stays
 * best-effort extraction, matching the same tradeoff already made for
 * PromQL/InfluxQL parsing elsewhere in this codebase.
 */
export function resolvePanelDataLinks(panel: Panel): ResolvedDataLink[] {
  const links: ResolvedDataLink[] = [];
  for (const link of panel.fieldConfig?.defaults?.links ?? []) {
    links.push({ title: link.title, url: link.url });
  }
  for (const override of panel.fieldConfig?.overrides ?? []) {
    const linksProperty = override.properties?.find((p) => p.id === 'links');
    if (!linksProperty) continue;
    const appliesToField =
      override.matcher?.id === 'byName' && typeof override.matcher.options === 'string' ? override.matcher.options : undefined;
    for (const link of (linksProperty.value as PanelDataLinkConfigLike[] | undefined) ?? []) {
      if (link?.url) links.push({ title: link.title, url: link.url, appliesToField });
    }
  }
  return links;
}

interface PanelDataLinkConfigLike {
  title?: string;
  url?: string;
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
      const targets = p.targets.map((t) => ({
        refId: t.refId,
        datasourceUid: datasourceRefToUid(t.datasource) ?? panelDsUid,
        raw: t,
      }));
      const mirrorTargets = targets.filter((t) => t.datasourceUid === DASHBOARD_MIRROR_REF);
      const mirrorsPanelIds =
        mirrorTargets.length > 0 && mirrorTargets.length === targets.length
          ? [...new Set(mirrorTargets.map((t) => t.raw.panelId).filter((id): id is number => typeof id === 'number'))]
          : undefined;
      return {
        panelId: p.id,
        title: p.title,
        type: p.type,
        targets,
        dataLinks: resolvePanelDataLinks(p),
        ...(mirrorsPanelIds ? { mirrorsPanelIds } : {}),
      };
    });
}

/**
 * Thrown instead of silently picking one when a dashboard has more than one
 * panel sharing the same id — confirmed against a real dashboard where a
 * provisioning bug (not Grafana's repeat-panel feature; no `repeat` field)
 * stamped ~24 genuinely different panels, one per product, all with id 9.
 * Silently returning the first would mean querying "panelId: 9" for e.g.
 * Compute silently returns Block Storage's data instead, with no error or
 * any other sign anything is wrong.
 */
export class AmbiguousPanelError extends Error {
  constructor(panelId: number, public readonly candidates: ResolvedPanel[]) {
    super(
      `Panel id ${panelId} is ambiguous on this dashboard — ${candidates.length} different panels share it: ` +
        `${candidates.map((p) => `"${p.title}"`).join(', ')}. Pass "panelTitle" (exact match) to pick one.`,
    );
    this.name = 'AmbiguousPanelError';
  }
}

export function findPanel(dashboard: DashboardJson, panelId: number, panelTitle?: string): ResolvedPanel | undefined {
  const matches = resolvePanelQueries(dashboard).filter((p) => p.panelId === panelId);
  if (matches.length <= 1) return matches[0];
  if (panelTitle) {
    const titleMatches = matches.filter((p) => p.title === panelTitle);
    if (titleMatches.length === 1) return titleMatches[0];
  }
  throw new AmbiguousPanelError(panelId, matches);
}
