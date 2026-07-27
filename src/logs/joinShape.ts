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

type QueryParserModule = typeof import('@liquescent/log-correlator-query-parser');
type QueryParser = InstanceType<QueryParserModule['PeggyQueryParser']>;

// Same parser the CorrelationEngine uses internally, so a query the engine
// accepts parses identically here. Constructed once (lazily) and cached;
// parse() is pure. Lazy, not a module-scope `new PeggyQueryParser()`, for
// the same reason correlate.ts's CorrelationEngine import is dynamic: this
// module sits on the static import chain every server startup runs
// (registerAll.ts -> correlateLogs.ts -> here), so a missing/broken
// @liquescent/log-correlator-query-parser install must only fail the first
// correlate_logs call it's actually needed for, not crash the whole MCP
// server at startup (companion to #145).
let parserPromise: Promise<QueryParser> | undefined;
function getParser(): Promise<QueryParser> {
  parserPromise ??= import('@liquescent/log-correlator-query-parser').then((m) => new m.PeggyQueryParser());
  return parserPromise;
}

/**
 * Parses a log-correlator join query far enough to know its join operator and
 * which selectors are on the right. Best-effort: an unparseable query (the
 * engine would already have thrown on it) yields an undefined joinType and no
 * right selectors, so callers simply fall back to the non-`unless` path.
 */
export async function joinShape(query: string): Promise<JoinShape> {
  try {
    const parser = await getParser();
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
