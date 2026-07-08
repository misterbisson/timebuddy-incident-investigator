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
  capturePanel(req: CapturePanelRequest): Promise<Buffer>;
}
