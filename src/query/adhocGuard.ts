/**
 * Statement guard for model-authored InfluxQL (see tools/executeAdhocQuery.ts).
 *
 * What this is for, stated plainly because it determines how strict it has to
 * be: this is an **accident guard, not an adversary fence**. Anyone who can set
 * `--allow-adhoc-queries` can also just open Grafana's Explore UI and type
 * whatever they want, so there is no threat model in which this function is the
 * last line of defense against a determined human. Its job is narrower and
 * real: stop an agent from destroying data *unprompted* while it iterates on a
 * query, and make the read-only claim in README.md's Security section still
 * true once the query body stops coming from a dashboard.
 *
 * That lower bar is what makes a classifier acceptable where a parser would
 * otherwise be required. `index-builder/extract.ts` already documents the
 * "best-effort regex, not a real parser" tradeoff for metric extraction; the
 * difference is that a miss there costs a missing index entry, whereas a miss
 * here could cost a measurement. So the two rules that keep the asymmetry safe:
 *
 * 1. **Allowlist the statement head, never blocklist the dangerous verbs.** A
 *    blocklist has to anticipate every destructive statement InfluxQL has now
 *    and adds later; an allowlist of SELECT/SHOW only has to be right about the
 *    two that are safe. `DROP`, `DELETE`, `ALTER`, `CREATE`, `GRANT`, `REVOKE`,
 *    `KILL` and anything InfluxDB adds in a future release are all refused by
 *    simply not being on the list.
 * 2. **Refuse anything unclassifiable.** Refusing an odd-but-valid query costs
 *    one retry; passing an unclassified one can cost data. Every early return
 *    in here is a refusal, and the accept is the single last line.
 *
 * The one genuinely destructive thing a SELECT can do is `SELECT ... INTO`,
 * which writes its result set into another measurement, so that gets its own
 * check rather than riding on the statement head.
 *
 * ## The caller executes `verdict.statement`, and that is deliberate
 *
 * `classifyInfluxQL` returns the **scanned** statement, not the caller's raw
 * input, and tools/executeAdhocQuery.ts sends that scanned text to the
 * datasource. Keep it that way. Every guarantee above is a statement about the
 * text this module inspected; executing the raw input instead would mean
 * checking one string and running a different one, which is how a guard becomes
 * decorative. If a future refactor makes the tool run `raw`, these checks stop
 * meaning anything and no test here would notice.
 *
 * ## One pass, quote-aware, comments and statement splitting together
 *
 * An earlier version stripped comments with a regex *before* tracking quote
 * state. That was wrong in a way worth recording: a `--` or block comment
 * *inside a string literal* truncated the query, and since the caller executes
 * the scanned text, a perfectly valid query was silently rewritten into a
 * different one before being run (`WHERE "note" = 'a--b'` became `WHERE
 * "note" = 'a`). It was fail-*safe* — the truncation produced an
 * unterminated-quote syntax error at the datasource rather than a dangerous
 * statement — but "neither refused nor preserved" is exactly the outcome rule 2
 * exists to forbid, and the agent got an opaque datasource error it couldn't
 * attribute. Scanning once, with literals and comments handled by the same
 * state machine, removes that whole class rather than patching instances of it.
 */

export type AdhocVerdict =
  | { allowed: true; statement: string }
  | { allowed: false; reason: string };

/** Statement heads whose InfluxQL forms only ever read. Everything else is refused by omission — see rule 1 above. */
const ALLOWED_HEADS = ['select', 'show'] as const;

/** What the scan ran out of input inside, if anything. Each is a refusal, with its own message. */
export type UnterminatedKind = 'string literal' | 'quoted identifier' | 'regular expression' | 'block comment';

export interface ScanResult {
  /**
   * Statements split on top-level `;` only. Comments are replaced with a single
   * space (matching InfluxDB's own lexer, where a comment is a token
   * separator); string literals, quoted identifiers, and regex literals are
   * preserved **verbatim**, because this is the text that gets executed.
   */
  statements: string[];
  /**
   * The same statements with the *contents* of every literal, quoted
   * identifier, and regex blanked to spaces. Keyword checks run against this so
   * a literal can never be mistaken for syntax — `WHERE action = 'into'` is not
   * a `SELECT ... INTO`, and `FROM "drop table"` is not a DROP. Delimiters are
   * kept so token boundaries still line up.
   */
  keywordText: string[];
  /** Set when input ended inside a literal/regex/comment — always a refusal. */
  unterminated?: UnterminatedKind;
}

type State = 'normal' | 'single' | 'double' | 'regex' | 'line-comment' | 'block-comment';

/**
 * Single-pass scanner. Walks the input once, tracking whether it's inside a
 * string literal, a quoted identifier, an InfluxQL regex literal, or a comment,
 * and emits both the executable text and a keyword-safe view of it.
 *
 * Regex literals are only entered after `=~` or `!~`, InfluxQL's two match
 * operators. That matters both ways: without it, a `;` inside `=~ /a;b/` splits
 * the statement and the query gets refused as "2 statements" (a misleading
 * reason for a single-statement query, and rule 2's own doc argues a vague
 * refusal gets retried blindly rather than corrected); with a naive "any slash
 * starts a regex", ordinary division (`SELECT value / 2`) would swallow the
 * rest of the query.
 */
export function scanInfluxQL(sql: string): ScanResult {
  const statements: string[] = [];
  const keywordText: string[] = [];
  let state: State = 'normal';
  let current = '';
  let currentKeywords = '';
  // Last two non-whitespace characters seen in normal state, to recognise the
  // `=~` / `!~` that precede a regex literal.
  let lastTwo = '';

  const pushStatement = () => {
    if (current.trim().length > 0) {
      statements.push(current.trim());
      keywordText.push(currentKeywords.trim());
    }
    current = '';
    currentKeywords = '';
  };
  /** Inside a literal: keep the real character for execution, a blank for keyword scanning. */
  const appendMasked = (ch: string) => {
    current += ch;
    currentKeywords += ' ';
  };
  /**
   * A literal's opening/closing delimiter. Kept in both views — a visible `''`
   * or `//` keeps token boundaries legible in keywordText, and the delimiter
   * itself can never be mistaken for a keyword. Resets `lastTwo` because a quote
   * definitively ends any operator sequence, so a `/` after a closing quote is
   * never read as continuing an earlier `=~`.
   */
  const appendDelimiter = (ch: string) => {
    current += ch;
    currentKeywords += ch;
    lastTwo = '';
  };
  const appendNormal = (ch: string) => {
    current += ch;
    currentKeywords += ch;
    if (!/\s/.test(ch)) lastTwo = (lastTwo + ch).slice(-2);
  };

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    switch (state) {
      case 'normal': {
        if (ch === '-' && next === '-') {
          state = 'line-comment';
          // A comment is a separator, not nothing: collapsing it to a space
          // keeps neighbouring tokens apart. Deleting it would turn
          // `SELECT/**/1` into `SELECT1` and refuse a valid read.
          appendNormal(' ');
          i += 1;
          continue;
        }
        if (ch === '/' && next === '*') {
          state = 'block-comment';
          appendNormal(' ');
          i += 1;
          continue;
        }
        if (ch === '/' && (lastTwo === '=~' || lastTwo === '!~')) {
          state = 'regex';
          appendDelimiter(ch);
          continue;
        }
        if (ch === "'") {
          state = 'single';
          appendDelimiter(ch);
          continue;
        }
        if (ch === '"') {
          state = 'double';
          appendDelimiter(ch);
          continue;
        }
        if (ch === ';') {
          pushStatement();
          lastTwo = '';
          continue;
        }
        appendNormal(ch);
        continue;
      }
      case 'single':
      case 'double':
      case 'regex': {
        // Backslash escapes the next character in all three, so an escaped
        // delimiter doesn't look like the closing one.
        if (ch === '\\' && next !== undefined) {
          appendMasked(ch);
          appendMasked(next);
          i += 1;
          continue;
        }
        const closer = state === 'single' ? "'" : state === 'double' ? '"' : '/';
        if (ch === closer) {
          state = 'normal';
          appendDelimiter(ch);
          continue;
        }
        appendMasked(ch);
        continue;
      }
      case 'line-comment': {
        if (ch === '\n') {
          state = 'normal';
          appendNormal('\n');
        }
        continue;
      }
      case 'block-comment': {
        if (ch === '*' && next === '/') {
          state = 'normal';
          i += 1;
        }
        continue;
      }
    }
  }
  pushStatement();

  const unterminated: UnterminatedKind | undefined =
    state === 'single'
      ? 'string literal'
      : state === 'double'
        ? 'quoted identifier'
        : state === 'regex'
          ? 'regular expression'
          : state === 'block-comment'
            ? 'block comment'
            : undefined;

  return unterminated ? { statements, keywordText, unterminated } : { statements, keywordText };
}

/**
 * Classifies one caller-supplied InfluxQL string as read-only-and-runnable, or
 * refused with a reason the agent can act on. The reason text is deliberately
 * specific about *which* rule tripped: a refusal that just says "not allowed"
 * gets retried blindly, while one that names `INTO` or the statement head gets
 * corrected.
 */
export function classifyInfluxQL(raw: string): AdhocVerdict {
  const scan = scanInfluxQL(raw);

  if (scan.unterminated) {
    return {
      allowed: false,
      reason:
        `Query ends inside an unterminated ${scan.unterminated} — it can't be classified as read-only, ` +
        'so it is refused rather than run. Close the quote, regex, or comment.',
    };
  }

  if (scan.statements.length === 0) {
    return { allowed: false, reason: 'Query is empty (or contained only comments).' };
  }
  if (scan.statements.length > 1) {
    return {
      allowed: false,
      reason:
        `Query contains ${scan.statements.length} statements — only a single statement is allowed. ` +
        'Run one query per call so each has its own audit record and Explore URL. ' +
        '(Semicolons inside string literals, quoted identifiers, and =~ /regex/ literals do not count.)',
    };
  }

  const statement = scan.statements[0]!;
  // Keyword checks run against the blanked view, so nothing inside a literal or
  // a quoted identifier can be mistaken for syntax.
  const keywords = scan.keywordText[0]!;

  const head = keywords.match(/^([a-z]+)/i)?.[1]?.toLowerCase();
  if (!head) {
    return {
      allowed: false,
      reason: `Query does not begin with a recognizable InfluxQL keyword: "${statement.slice(0, 40)}".`,
    };
  }
  if (!ALLOWED_HEADS.includes(head as (typeof ALLOWED_HEADS)[number])) {
    return {
      allowed: false,
      reason:
        `Only SELECT and SHOW statements are allowed here; this one begins with "${head.toUpperCase()}". ` +
        'Anything that could write, delete, or alter data or schema is refused.',
    };
  }

  // SELECT ... INTO <measurement> writes its result set back into the
  // database, so it's the one read-shaped statement that isn't a read.
  //
  // \b rather than an explicit separator class: \b's word set is [A-Za-z0-9_],
  // so this still passes an identifier that merely contains the letters (a
  // field named "into_bytes") while catching INTO adjacent to any punctuation —
  // including `SELECT *INTO "x"`, which a whitespace/paren class would miss
  // because `*` isn't in it. Running against the blanked view means a literal
  // `'into'` no longer false-positives the way it did before scanning was
  // literal-aware.
  if (/\binto\b/i.test(keywords)) {
    return {
      allowed: false,
      reason:
        'SELECT ... INTO writes its results into another measurement, so it is refused even though it ' +
        'begins with SELECT. Remove the INTO clause to run this as a read.',
    };
  }

  return { allowed: true, statement };
}
