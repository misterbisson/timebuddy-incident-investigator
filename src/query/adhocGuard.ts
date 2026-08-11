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
 */

export type AdhocVerdict =
  | { allowed: true; statement: string }
  | { allowed: false; reason: string };

/** Statement heads whose InfluxQL forms only ever read. Everything else is refused by omission — see rule 1 above. */
const ALLOWED_HEADS = ['select', 'show'] as const;

/**
 * Strips InfluxQL comments so they can't hide a second statement or an `INTO`
 * from the checks below. Both forms InfluxDB accepts are handled: double-dash
 * to end of line, and C-style block comments.
 *
 * Each is replaced with a space rather than deleted, because that is what
 * InfluxDB's own lexer does: a comment is a token separator there too. Deleting
 * would glue neighbouring tokens together and make this checker read a
 * different statement than the database will — `SELECT/^*^/1` would become
 * `SELECT1`, failing the statement-head allowlist below and refusing a query
 * that is in fact a valid read. (The reverse case is not a hole: `IN/^*^/TO` is
 * two tokens to InfluxDB as well, so it is a syntax error rather than a
 * disguised `INTO`.) Carets stand in for asterisks above so this comment can
 * describe a block comment without ending itself.
 */
export function stripInfluxComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * Splits on semicolons that sit outside string literals. InfluxQL string
 * literals are single-quoted and identifiers double-quoted, and a `;` inside
 * either is data, not a statement separator — so a naive `split(';')` would
 * reject the perfectly legal `SELECT * FROM "m" WHERE tag = 'a;b'`. Tracking
 * quote state keeps that query usable without letting a real second statement
 * through.
 */
export function splitInfluxStatements(sql: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    if (quote) {
      // InfluxQL escapes a quote inside a literal with a backslash; skip the
      // next character so an escaped quote doesn't look like the closing one.
      if (ch === '\\') {
        current += ch + (sql[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (ch === quote) quote = undefined;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Classifies one caller-supplied InfluxQL string as read-only-and-runnable, or
 * refused with a reason the agent can act on. The reason text is deliberately
 * specific about *which* rule tripped: a refusal that just says "not allowed"
 * gets retried blindly, while one that names `INTO` or the statement head gets
 * corrected.
 */
export function classifyInfluxQL(raw: string): AdhocVerdict {
  const withoutComments = stripInfluxComments(raw);
  const trimmed = withoutComments.trim();

  if (trimmed.length === 0) {
    return { allowed: false, reason: 'Query is empty (or contained only comments).' };
  }

  const statements = splitInfluxStatements(trimmed);
  if (statements.length === 0) {
    return { allowed: false, reason: 'Query is empty after removing comments and separators.' };
  }
  if (statements.length > 1) {
    return {
      allowed: false,
      reason:
        `Query contains ${statements.length} statements — only a single statement is allowed. ` +
        'Run one query per call so each has its own audit record and Explore URL.',
    };
  }

  const statement = statements[0]!;
  const head = statement.match(/^([a-z]+)/i)?.[1]?.toLowerCase();
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
  // field named "into_bytes", a measurement "point_into") while catching INTO
  // adjacent to any punctuation — including `SELECT *INTO "x"`, which an
  // explicit whitespace/paren class would have missed because `*` isn't in it.
  //
  // Known and accepted false positive: this also refuses a query whose string
  // literal happens to be the bare word 'into' (`WHERE action = 'into'`), since
  // literals aren't stripped before the test. Per this module's rule 2 that's
  // the correct direction to err — a needless refusal costs one retry.
  if (/\binto\b/i.test(statement)) {
    return {
      allowed: false,
      reason:
        'SELECT ... INTO writes its results into another measurement, so it is refused even though it ' +
        'begins with SELECT. Remove the INTO clause to run this as a read.',
    };
  }

  return { allowed: true, statement };
}
