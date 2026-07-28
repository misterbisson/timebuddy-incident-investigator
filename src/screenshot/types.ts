export interface CapturePanelRequest {
  /** A fully-formed Grafana "d-solo" panel URL, ready to navigate to directly. */
  url: string;
  /**
   * Applied to every outgoing request from the capturing browser context,
   * not just the initial navigation — Grafana's own frontend issues its
   * data queries as separate fetch calls after the page loads, and those
   * need the same auth the page itself did.
   */
  headers: Record<string, string>;
  width: number;
  height: number;
  timeoutMs: number;
}

export interface CapturePanelResult {
  png: Buffer;
  /**
   * The content size the captured image actually came back at, read from the
   * NativeImage (image.getSize()) rather than assumed from the requested
   * width/height. The OS, useContentSize adjustment, or the area backstop can
   * all land the window at a different size than asked for, so this is the only
   * honest source for "what was really captured" — see issue #96.
   */
  width: number;
  height: number;
}

export interface ExportPanelCsvRequest {
  /** The full (chrome-included) dashboard/panel URL with the Inspect/Data drawer pre-opened — see grafana/urlBuilder.ts's buildInspectDataUrl. */
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface ExportPanelCsvResult {
  /**
   * The exact bytes Grafana's own "Download CSV" button produces for this
   * panel with "Apply panel transformations" checked. Undefined when this
   * panel has no transformations configured at all — Grafana only renders
   * that checkbox when there's something for it to do, which doubles as a
   * reliable "is there anything here we'd otherwise miss" signal. Callers
   * should fall back to the direct /api/ds/query-based export in that case:
   * it's both cheaper and exactly as correct for an untransformed panel.
   */
  csv?: Buffer;
}

/**
 * Renders a Grafana panel URL in a real browser and captures it as a PNG —
 * the client-side fallback for when the target Grafana instance has no
 * server-side Image Renderer plugin installed (the common case). Implemented
 * by the Electron app, which already bundles a full Chromium for its own GUI,
 * and passed into the engine via ToolContext's optional `screenshotter`
 * field. The standalone CLI has no browser to drive, so `screenshot_panel`
 * simply isn't registered when this isn't supplied.
 */
export interface Screenshotter {
  capturePanel(req: CapturePanelRequest): Promise<CapturePanelResult>;
  /**
   * Reproduces a panel's actual on-screen data — including Grafana-side
   * panel transformations (joins, reduces, renames, ...) that this server's
   * own /api/ds/query-based export can't see, since those only ever run in
   * Grafana's own frontend. Driven by navigating a real browser straight to
   * the panel's Inspect/Data URL, checking "Apply panel transformations" (a
   * few DOM interactions, not a public API — see electron/src/screenshotter.js
   * for exactly what it depends on), and intercepting the real "Download CSV"
   * click. export_panel_csv falls back to its own direct export when this
   * throws (page/DOM didn't behave as expected) or returns no csv (nothing
   * to reproduce this way).
   */
  exportPanelCsv(req: ExportPanelCsvRequest): Promise<ExportPanelCsvResult>;
}
