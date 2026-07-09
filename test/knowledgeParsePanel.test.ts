import { describe, expect, it } from 'vitest';
import { parseKnowledgePanel, productKeyFromPanelTitle } from '../src/knowledge/parsePanel.js';

describe('productKeyFromPanelTitle', () => {
  it('extracts the key from a "timebuddy: <key>" title, case-insensitively and trimmed', () => {
    expect(productKeyFromPanelTitle('timebuddy: block-storage')).toBe('block-storage');
    expect(productKeyFromPanelTitle('Timebuddy:block-storage')).toBe('block-storage');
    expect(productKeyFromPanelTitle('TIMEBUDDY:   Block-Storage  ')).toBe('Block-Storage');
  });

  it('returns undefined for a title that does not follow the convention', () => {
    expect(productKeyFromPanelTitle('Error rate')).toBeUndefined();
    expect(productKeyFromPanelTitle(undefined)).toBeUndefined();
  });
});

describe('parseKnowledgePanel', () => {
  it('parses a fenced json block and strips it from the prose', () => {
    const markdown = '```json\n{"owner":"platform-team"}\n```\n\nKnown false positive during deploys.';
    const result = parseKnowledgePanel(markdown);
    expect(result.json).toEqual({ owner: 'platform-team' });
    expect(result.prose).toBe('Known false positive during deploys.');
    expect(result.parseError).toBeUndefined();
  });

  it('falls back to the full raw text, with parseError, when the json block is malformed', () => {
    const markdown = '```json\n{not valid json\n```\n\nSome prose.';
    const result = parseKnowledgePanel(markdown);
    expect(result.json).toBeUndefined();
    expect(result.parseError).toBe(true);
    expect(result.prose).toBe(markdown.trim());
  });

  it('falls back to the raw text, with no parseError, when there is no fenced json block at all', () => {
    const markdown = 'Just prose, no json block.';
    const result = parseKnowledgePanel(markdown);
    expect(result.json).toBeUndefined();
    expect(result.parseError).toBeUndefined();
    expect(result.prose).toBe(markdown);
  });
});
