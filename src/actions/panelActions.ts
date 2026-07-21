import type { Config } from '../config.js';
import type { ConnectionsSource } from '../grafana/registry.js';
import { ConnectionRegistry } from '../grafana/registry.js';
import { loadConfig } from '../config.js';
import type { Screenshotter } from '../screenshot/types.js';
import { dashboardUrlFor } from '../tools/shared.js';
import { redact } from '../security/redact.js';
import {
  DEFAULT_SCREENSHOT_HEIGHT,
  DEFAULT_SCREENSHOT_WIDTH,
  FORMULA_NEUTRALIZATION_NOTE,
  MULTI_FILE_NOTE,
  generatePanelCsv,
  generatePanelPng,
  type PanelInvocation,
  type PanelInvocationInput,
  resolvePanelInvocation,
} from '../tools/panelInvocation.js';

/**
 * A non-agent, in-process entry point to the exact same panel screenshot / CSV
 * export the screenshot_panel and export_panel_csv MCP tools perform — used by
 * the Electron Activity window's "Capture screenshot" / "Export CSV" buttons,
 * which act on an already-recorded activity entry and so have no calling agent
 * to hand an MCP result to. It runs the shared core in tools/panelInvocation.ts
 * (identical resolution, redaction, and formula-neutralization to the tools),
 * but returns bytes + a suggested filename rather than writing under DATA_DIR:
 * the caller (electron/src/main.js) writes them to the user's Downloads folder
 * and reveals them in the OS file manager.
 *
 * Deliberately does NOT record activity entries — a button pressed on an
 * existing entry shouldn't spawn a second one; the activity log stays a record
 * of what tool calls happened, not what the person clicked afterward.
 */
export interface PanelActionInput extends PanelInvocationInput {
  /** Screenshot only; defaults to the same 1600x900 screenshot_panel uses. */
  width?: number;
  height?: number;
}

export interface PanelScreenshotResult {
  png: Buffer;
  suggestedFilename: string;
  meta: Record<string, unknown>;
}

export interface PanelCsvFileResult {
  suggestedFilename: string;
  /** Already redacted and neutralized against spreadsheet formula injection. */
  content: string;
  refId?: string;
  rows: number;
  columns: string[];
}

export interface PanelCsvResult {
  files: PanelCsvFileResult[];
  meta: Record<string, unknown>;
}

export interface PanelActions {
  screenshot(input: PanelActionInput): Promise<PanelScreenshotResult>;
  exportCsv(input: PanelActionInput): Promise<PanelCsvResult>;
}

/**
 * Builds the config + connection registry the same way createServer does (a
 * startup snapshot for the zero-connections guard/logging, but the live
 * `source` thunk for the registry so a connection edited in the GUI is picked
 * up on the next call), then exposes the two panel actions against it.
 */
export function createPanelActions(
  source: ConnectionsSource,
  configOverrides: Partial<Config> = {},
  screenshotter: Screenshotter,
): PanelActions {
  const startupSnapshot = typeof source === 'function' ? source() : source;
  const config: Config = { ...loadConfig(), ...configOverrides, connections: startupSnapshot };
  const registry = new ConnectionRegistry(source, config);

  const resultUrlFor = (inv: PanelInvocation): string | undefined =>
    dashboardUrlFor(registry, inv.connectionId, inv.dashboardUid, {
      panelId: inv.panelId,
      fromMs: inv.fromMs,
      toMs: inv.toMs,
      variables: inv.overrides,
    });

  return {
    async screenshot(input) {
      const inv = await resolvePanelInvocation(registry, config, input, {
        toolName: 'screenshot_panel',
        verb: 'capture',
        windowLabel: 'screenshot',
      });
      const { png, width, height, warnings } = await generatePanelPng(screenshotter, config, inv, {
        width: input.width ?? DEFAULT_SCREENSHOT_WIDTH,
        height: input.height ?? DEFAULT_SCREENSHOT_HEIGHT,
      });
      const meta = redact(
        {
          url: resultUrlFor(inv),
          dashboardUid: inv.dashboardUid,
          panelId: inv.panelId,
          title: inv.panel.title,
          type: inv.panel.type,
          window: { fromMs: inv.fromMs, toMs: inv.toMs },
          width,
          height,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
        config.redactionPatterns,
      );
      return { png, suggestedFilename: suggestName(inv, 'png', config.redactionPatterns), meta };
    },

    async exportCsv(input) {
      const inv = await resolvePanelInvocation(registry, config, input, {
        toolName: 'export_panel_csv',
        verb: 'export',
        windowLabel: 'export',
      });
      const generated = await generatePanelCsv(screenshotter, config, inv);
      const files: PanelCsvFileResult[] = generated.files.map((f) => ({
        suggestedFilename: suggestName(inv, 'csv', config.redactionPatterns, f.suffix),
        content: f.content,
        ...(f.refId ? { refId: f.refId } : {}),
        rows: f.rows,
        // Column names can carry a configured customer identifier just like the
        // file content (which generatePanelCsv already redacts). Redact them
        // here too, so the returned metadata can't disagree with the file it
        // describes — the MCP export_panel_csv path redacts its whole result
        // for the same reason.
        columns: f.columns.map((c) => redact(c, config.redactionPatterns)),
      }));
      const meta = redact(
        {
          url: resultUrlFor(inv),
          dashboardUid: inv.dashboardUid,
          panelId: inv.panelId,
          title: inv.panel.title,
          type: inv.panel.type,
          window: { fromMs: inv.fromMs, toMs: inv.toMs },
          transformationsApplied: generated.transformationsApplied,
          formulaNeutralized: true,
          ...(generated.transformationsApplied ? { formulaNeutralizationNote: FORMULA_NEUTRALIZATION_NOTE } : {}),
          ...(Object.keys(generated.errors).length > 0 ? { errors: generated.errors } : {}),
          ...(generated.unresolvedAllVariables.length > 0 ? { unresolvedAllVariables: generated.unresolvedAllVariables } : {}),
          ...(generated.captureNote ? { transformCaptureNote: generated.captureNote } : {}),
          ...(files.length > 1 ? { note: MULTI_FILE_NOTE } : {}),
        },
        config.redactionPatterns,
      );
      return { files, meta };
    },
  };
}

/**
 * A human-readable, filesystem-safe base name for a downloaded file: the
 * panel's title (falling back to the dashboard title, then its uid), plus the
 * panel id and any multi-frame suffix. The caller owns collision handling in
 * the target directory — this only guarantees the name has no path-significant
 * or reserved characters and isn't empty.
 *
 * Configured customer identifiers are redacted out of the label *before*
 * sanitizing, so a matched identifier never survives into the on-disk Downloads
 * filename (nor the `suggestedFilename` returned to the renderer) — matching how
 * `meta.title` and the CSV content are already masked.
 */
function suggestName(
  inv: PanelInvocation,
  ext: 'png' | 'csv',
  redactionPatterns: RegExp[],
  suffix?: string,
): string {
  const label = inv.panel.title || inv.dashboard.title || inv.dashboardUid;
  const base = sanitizeForFilename(redact(label, redactionPatterns));
  return `${base}-panel${inv.panelId}${suffix ? `-${sanitizeForFilename(suffix)}` : ''}.${ext}`;
}

function sanitizeForFilename(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._]+|_+$/g, '')
      .slice(0, 80) || 'panel'
  );
}
