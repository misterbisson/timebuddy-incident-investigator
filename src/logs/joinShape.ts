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
  /**
   * The source name each stream is written with (`graylog`, `loki`, ...), so
   * correlate_logs can tell a query written for the wrong kind of log source
   * before the engine fails on it with a less useful message.
   */
  sources: string[];
  /**
   * Every stream selector the engine would run as different text from what the
   * caller wrote, because of the engine's whitespace normalization (see
   * `normalizeLikeEngine`). Empty when nothing is rewritten. correlate_logs
   * refuses a query with any entry here, since a rewritten quoted value is a
   * different value (issue #273).
   */
  rewrittenSelectors: Array<{ written: string; sent: string }>;
  /**
   * Set when the query parses only *after* the engine's normalization, so the
   * selectors as written can't be compared with what would be sent — e.g. a
   * non-breaking space, which the grammar doesn't accept but `\s` matches.
   * correlate_logs refuses this too rather than run text it couldn't check.
   */
  parsesOnlyNormalized?: true;
}

/**
 * The exact normalization `CorrelationEngine.parseQuery` (and `validateQuery`)
 * in `@liquescent/log-correlator-core` applies before parsing: trim, then
 * collapse every whitespace run to one space — inside quoted values too. The
 * selectors it hands the adapters come from parsing *this* text, so anything
 * here that compares against them must parse it too.
 */
export function normalizeLikeEngine(query: string): string {
  return query.trim().replace(/\s+/g, ' ');
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

type Parsed = ReturnType<QueryParser['parse']>;

function streamsOf(parsed: Parsed) {
  return [parsed.leftStream, parsed.rightStream, ...(parsed.additionalStreams ?? [])];
}

function tryParse(parser: QueryParser, query: string): Parsed | undefined {
  try {
    return parser.parse(query);
  } catch {
    return undefined;
  }
}

/**
 * Parses a log-correlator join query far enough to know its join operator and
 * which selectors are on the right. Best-effort: an unparseable query (the
 * engine would already have thrown on it) yields an undefined joinType and no
 * right selectors, so callers simply fall back to the non-`unless` path.
 *
 * The shape is read from the query as the engine will parse it, after
 * `normalizeLikeEngine`, so `rightSelectors` are the same strings the adapters
 * report fetch stats under. The query is also parsed as written, and any
 * selector that differs between the two parses is listed in
 * `rewrittenSelectors`. The grammar already drops whitespace between tokens,
 * so in practice that is a quoted value containing a whitespace run, a tab,
 * or a newline.
 */
export async function joinShape(query: string): Promise<JoinShape> {
  let parser: QueryParser;
  try {
    parser = await getParser();
  } catch {
    return { joinType: undefined, rightSelectors: [], sources: [], rewrittenSelectors: [] };
  }
  const sent = tryParse(parser, normalizeLikeEngine(query));
  if (!sent) return { joinType: undefined, rightSelectors: [], sources: [], rewrittenSelectors: [] };

  const rightSelectors = [sent.rightStream?.selector, ...(sent.additionalStreams ?? []).map((s) => s.selector)]
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim());
  const sources = streamsOf(sent)
    .map((s) => s?.source)
    .filter((s): s is string => typeof s === 'string');
  const shape = { joinType: sent.joinType, rightSelectors, sources };

  const written = tryParse(parser, query);
  if (!written) return { ...shape, rewrittenSelectors: [], parsesOnlyNormalized: true };

  const writtenStreams = streamsOf(written);
  const sentStreams = streamsOf(sent);
  const rewrittenSelectors: JoinShape['rewrittenSelectors'] = [];
  for (let i = 0; i < Math.max(writtenStreams.length, sentStreams.length); i += 1) {
    const w = writtenStreams[i]?.selector;
    const s = sentStreams[i]?.selector;
    if (w !== s) rewrittenSelectors.push({ written: String(w), sent: String(s) });
  }
  return { ...shape, rewrittenSelectors };
}
