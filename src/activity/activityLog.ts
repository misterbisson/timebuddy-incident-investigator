/**
 * In-memory, per-process log of dashboards/panels actually queried during an
 * investigation — surfaced by the Electron app's Activity window (see
 * electron/src/main.js) so a person can see what's being inspected as tool
 * calls happen, and revisit any of it (screenshot or live Grafana view)
 * afterward. Deliberately not persisted to disk: this is a live companion
 * view, not an audit trail (security/audit.ts already covers that).
 */
/**
 * Fields every entry carries regardless of what was inspected. `url` is the
 * clickable link back to the source (a Grafana panel view, or a Graylog
 * search); the renderer uses it for the "open in browser" affordance.
 */
interface ActivityEntryCommon {
  toolName: string;
  connectionId: string;
  connectionName?: string;
  url?: string;
}

/**
 * A Grafana dashboard/panel that was actually queried or screenshotted. This
 * is the only shape that existed before Graylog support — every existing
 * call site produces one of these (recordActivity stamps `kind: 'panel'`).
 */
export interface PanelActivityEntry extends ActivityEntryCommon {
  kind: 'panel';
  dashboardUid: string;
  dashboardTitle?: string;
  panelId?: number;
  panelTitle?: string;
  /** Only set when the tool that produced this entry saved a screenshot (screenshot_panel). */
  screenshotPath?: string;
}

/** A Graylog search/correlation that was run (search_logs / correlate_logs). */
export interface LogActivityEntry extends ActivityEntryCommon {
  kind: 'log';
  /** The Graylog/Lucene query (search_logs) or join query (correlate_logs) that was run. */
  query: string;
  streamId?: string;
  streamName?: string;
  /** Total matching messages (search_logs) or correlated groups (correlate_logs). */
  resultCount?: number;
}

/**
 * A discriminated union rather than one interface with a pile of optional
 * fields: a reader switches on `kind` and TypeScript makes the panel-only or
 * log-only fields available (and required) only in the matching branch, so a
 * new `kind` can't silently skip a consumer. `id`/`timestamp` are assigned by
 * the log itself, so tools record everything but those two.
 */
export type ActivityEntryInput = PanelActivityEntry | LogActivityEntry;
export type ActivityEntry = ActivityEntryInput & { id: string; timestamp: string };

export interface ActivityLog {
  record(entry: ActivityEntryInput): void;
}

const DEFAULT_MAX_ENTRIES = 1000;

/**
 * maxEntries is a safety net against unbounded memory growth over a very long
 * session, not a feature in its own right — capped well above what any real
 * investigation would produce.
 */
export function createActivityLog(maxEntries: number = DEFAULT_MAX_ENTRIES): ActivityLog & {
  list(): ActivityEntry[];
  onEntry(cb: (entry: ActivityEntry) => void): () => void;
} {
  let nextId = 1;
  const entries: ActivityEntry[] = [];
  const listeners = new Set<(entry: ActivityEntry) => void>();

  return {
    record(input) {
      const entry: ActivityEntry = { ...input, id: String(nextId++), timestamp: new Date().toISOString() };
      entries.push(entry);
      if (entries.length > maxEntries) entries.shift();
      for (const listener of listeners) listener(entry);
    },
    list() {
      return [...entries];
    },
    onEntry(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
