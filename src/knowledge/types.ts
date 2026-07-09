/** One knowledge panel's parsed content, cached per dashboard version. */
export interface CachedPanelContent {
  panelId: number;
  panelTitle: string;
  json?: unknown;
  prose: string;
  parseError?: boolean;
}

/** Result of a successful get_alert_context/get_product_context knowledge lookup. */
export interface ProductKnowledge {
  dashboardUid: string;
  panelId: number;
  panelTitle: string;
  /** Which candidate key (a dashboard tag or alert label value) actually matched. */
  matchedKey: string;
  json?: unknown;
  prose: string;
  parseError?: boolean;
}
