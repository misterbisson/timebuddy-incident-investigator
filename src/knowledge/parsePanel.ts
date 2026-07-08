const PANEL_TITLE_PATTERN = /^timebuddy:\s*(.+)$/i;

/** Extracts the product key from a knowledge panel's title (`timebuddy: <key>`), or undefined if the title doesn't follow that convention. */
export function productKeyFromPanelTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  return title.match(PANEL_TITLE_PATTERN)?.[1]?.trim();
}

const JSON_FENCE_PATTERN = /```json\s*\n([\s\S]*?)```/i;

export interface ParsedKnowledgePanel {
  json?: unknown;
  prose: string;
  parseError?: boolean;
}

/**
 * Extracts the fenced ```json block a knowledge panel's markdown is expected
 * to start with; the rest of the markdown (fence removed) is `prose`, kept
 * for a human/agent to read regardless of whether the JSON parsed. A missing
 * fence or invalid JSON degrades to the full raw markdown with
 * `parseError: true` rather than throwing — a malformed knowledge panel
 * shouldn't break the tool call it's attached to.
 */
export function parseKnowledgePanel(markdown: string): ParsedKnowledgePanel {
  const match = markdown.match(JSON_FENCE_PATTERN);
  if (!match || match.index === undefined) return { prose: markdown.trim() };
  try {
    const json = JSON.parse(match[1]!);
    const prose = (markdown.slice(0, match.index) + markdown.slice(match.index + match[0].length)).trim();
    return { json, prose };
  } catch {
    return { prose: markdown.trim(), parseError: true };
  }
}
