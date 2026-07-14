/**
 * In-memory, per-process log of dashboards/panels actually queried during an
 * investigation — surfaced by the Electron app's Activity window (see
 * electron/src/main.js) so a person can see what's being inspected as tool
 * calls happen, and revisit any of it (screenshot or live Grafana view)
 * afterward. Deliberately not persisted to disk: this is a live companion
 * view, not an audit trail (security/audit.ts already covers that).
 */
export interface ActivityEntry {
  id: string;
  timestamp: string;
  toolName: string;
  connectionId: string;
  connectionName?: string;
  dashboardUid: string;
  dashboardTitle?: string;
  panelId?: number;
  panelTitle?: string;
  url?: string;
  /** Only set when the tool that produced this entry saved a screenshot (screenshot_panel). */
  screenshotPath?: string;
}

export interface ActivityLog {
  record(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): void;
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
