/** Shapes for the subset of the Grafana HTTP API this server reads. */

export interface DatasourceRef {
  uid: string;
  type?: string;
}

export interface PanelTarget {
  refId: string;
  datasource?: DatasourceRef;
  /** Prometheus */
  expr?: string;
  legendFormat?: string;
  instant?: boolean;
  range?: boolean;
  /** InfluxQL (raw-query mode) */
  query?: string;
  rawQuery?: boolean;
  resultFormat?: string;
  /** InfluxQL structured query builder (best-effort support) */
  measurement?: string;
  policy?: string;
  select?: unknown[][];
  groupBy?: unknown[][];
  tags?: Array<{ key: string; operator: string; value: string }>;
  [key: string]: unknown;
}

/** A Grafana "data link" — a URL template with macros like ${__from}/${__to}/${__data.fields["X"]}, resolved client-side in the Grafana UI when a row/point is clicked. */
export interface PanelDataLinkConfig {
  title?: string;
  url: string;
}

export interface FieldConfigOverride {
  matcher?: { id?: string; options?: unknown };
  properties?: Array<{ id: string; value: unknown }>;
}

export interface Panel {
  id: number;
  title?: string;
  type?: string;
  datasource?: DatasourceRef | string | null;
  targets?: PanelTarget[];
  panels?: Panel[]; // row/nested panels
  fieldConfig?: {
    /** Applies to every field. */
    defaults?: { links?: PanelDataLinkConfig[] };
    /** Applies only to fields matched by e.g. { id: 'byName', options: '<field name>' }. */
    overrides?: FieldConfigOverride[];
  };
  /** Populated for a "text" panel (type: 'text'); its markdown/HTML body. */
  options?: { content?: string; mode?: string };
}

export interface TemplateVariableOption {
  text: string;
  value: string;
  selected?: boolean;
}

export interface TemplateVariable {
  name: string;
  type: 'query' | 'custom' | 'interval' | 'datasource' | 'textbox' | 'constant' | 'adhoc' | string;
  datasource?: DatasourceRef | string | null;
  query?: string | { query?: string; [key: string]: unknown };
  current?: { text?: string | string[]; value?: string | string[] };
  options?: TemplateVariableOption[];
  multi?: boolean;
  includeAll?: boolean;
  allValue?: string | null;
  regex?: string;
}

export interface DashboardJson {
  uid: string;
  title: string;
  tags?: string[];
  panels?: Panel[];
  templating?: { list?: TemplateVariable[] };
  time?: { from: string; to: string };
  /** Bumped by Grafana on every save; used to detect a changed dashboard without diffing its body. */
  version?: number;
}

export interface DashboardGetResponse {
  dashboard: DashboardJson;
  meta: {
    folderUid?: string;
    folderTitle?: string;
    url?: string;
    slug?: string;
    updated?: string;
    /** Login/display name of whoever last saved the dashboard - used as a "same author" relatedness signal, see findRelatedDashboards.ts. */
    updatedBy?: string;
    created?: string;
    createdBy?: string;
  };
}

/** `GET /api/folders/:uid`. `parentUid` is only present when nested folders are enabled and this isn't a root folder. */
export interface FolderInfo {
  uid: string;
  title: string;
  parentUid?: string;
}

export interface SearchResultItem {
  uid: string;
  title: string;
  type: 'dash-db' | 'dash-folder' | string;
  tags: string[];
  folderUid?: string;
  url: string;
}

export interface DatasourceInfo {
  uid: string;
  id: number;
  name: string;
  type: string;
  url?: string;
  isDefault?: boolean;
}

export interface DsQueryTarget {
  refId: string;
  datasource: DatasourceRef;
  maxDataPoints?: number;
  intervalMs?: number;
  [key: string]: unknown;
}

export interface DsQueryRequest {
  queries: DsQueryTarget[];
  from: string;
  to: string;
}

/** Grafana backend data-frame response, keyed by refId under results. */
export interface DsQueryResponse {
  results: Record<
    string,
    {
      status?: number;
      error?: string;
      frames?: GrafanaFrame[];
    }
  >;
}

export interface GrafanaFrame {
  schema: {
    refId?: string;
    fields: Array<{ name: string; type: string; labels?: Record<string, string> }>;
  };
  data: {
    values: unknown[][];
  };
}

export interface AlertmanagerAlert {
  fingerprint: string;
  status: { state: 'firing' | 'resolved' | string };
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL?: string;
  dashboardURL?: string;
  panelURL?: string;
}

export interface RulerAlertQuery {
  refId: string;
  datasourceUid?: string;
  model: Record<string, unknown>;
  relativeTimeRange?: { from: number; to: number };
}

/**
 * The shape of a single rule from the provisioning API
 * (`/api/v1/provisioning/alert-rules/{uid}`, see GrafanaClient.getAlertRuleByUid)
 * — annotations/labels live directly on this object there.
 */
export interface RulerAlertRule {
  uid: string;
  title: string;
  condition: string;
  data: RulerAlertQuery[];
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  for?: string;
}

export interface RulerRuleGroup {
  name: string;
  folderUid?: string;
  /**
   * The bulk ruler API (`/api/ruler/grafana/api/v1/rules`, see
   * GrafanaClient.getRuleGroups) nests each rule differently from the
   * provisioning API above: annotations/labels are siblings of
   * grafana_alert, not fields on it — grafana_alert itself only carries
   * uid/title/condition/data/... Confirmed against a real Grafana instance;
   * getting this wrong means every rule's annotations read as undefined
   * with no error, which is exactly what happened before this was fixed.
   */
  rules: Array<{
    grafana_alert: Omit<RulerAlertRule, 'annotations' | 'labels' | 'for'>;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    for?: string;
  }>;
}

export interface GrafanaAnnotation {
  id: number;
  dashboardUID?: string;
  panelId?: number;
  time: number;
  timeEnd?: number;
  text: string;
  tags?: string[];
}
