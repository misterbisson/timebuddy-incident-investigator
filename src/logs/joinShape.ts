import { PeggyQueryParser } from '@liquescent/log-correlator-query-parser';

export interface JoinShape {
  joinType: 'and' | 'or' | 'unless' | undefined;
  /**
   * Trimmed selectors on the right-hand side of the join — the *subtracted*
   * side for an `unless` anti-join. correlate_logs uses this to decide whether
   * a truncated stream sits on the side that would invert the result: a
   * truncated right side of `unless` can report a left event as "unmatched"
   * when a match exists just past the fetch cap.
   */
  rightSelectors: string[];
}

// Same parser the CorrelationEngine uses internally, so a query the engine
// accepts parses identically here. Constructed once; parse() is pure.
const parser = new PeggyQueryParser();

/**
 * Parses a log-correlator join query far enough to know its join operator and
 * which selectors are on the right. Best-effort: an unparseable query (the
 * engine would already have thrown on it) yields an undefined joinType and no
 * right selectors, so callers simply fall back to the non-`unless` path.
 */
export function joinShape(query: string): JoinShape {
  try {
    const parsed = parser.parse(query);
    const rightSelectors = [
      parsed.rightStream?.selector,
      ...(parsed.additionalStreams ?? []).map((s) => s.selector),
    ]
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim());
    return { joinType: parsed.joinType, rightSelectors };
  } catch {
    return { joinType: undefined, rightSelectors: [] };
  }
}
