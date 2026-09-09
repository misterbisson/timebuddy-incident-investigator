/**
 * Statement guard and step planner for model-authored PromQL/MetricsQL (see
 * tools/executeAdhocQuery.ts, and issue #212 for why this exists at all).
 *
 * ## Why this guard looks nothing like adhocGuard.ts's
 *
 * `query/adhocGuard.ts` classifies InfluxQL because it has to: `/api/ds/query`
 * is read-only *for the queries the other tools send*, not in general, and
 * InfluxQL over that endpoint accepts `DROP MEASUREMENT`, `DELETE FROM`, and
 * `SELECT … INTO`. There, read-only-ness is a property of the **statement**, so
 * something has to look at the statement.
 *
 * PromQL is the other case. Read-only-ness is a property of the **language and
 * the endpoints it reaches**: the language has no write, delete, or DDL form at
 * all, and Grafana's Prometheus backend only ever issues `/api/v1/query`,
 * `/api/v1/query_range`, and `/api/v1/query_exemplars` — the expression travels
 * as a request *parameter*, never as part of a path, so no expression text can
 * redirect the request at a mutating endpoint. That is why the issue could
 * fairly call this "simpler than the InfluxQL SELECT/SHOW allowlist": there is
 * no destructive statement head to keep off a list.
 *
 * So the honest thing is to say what this guard *does* assert rather than
 * dress it up as the same kind of check:
 *
 * 1. **One expression per call.** The tool's audit record, its `provenance`
 *    marking, and its replayable Explore URL are all one-per-call. A body that
 *    smuggles a second query past them would make all three describe something
 *    other than what ran, which is the same failure adhocGuard's
 *    single-statement rule exists to prevent — arrived at from the other
 *    direction.
 * 2. **Refuse what it can't classify as one expression.** Unterminated string,
 *    unbalanced bracket, nothing but comments: each is a refusal with a reason
 *    naming the specific problem, because a refusal that just says "invalid"
 *    gets retried blindly while one that names the unclosed quote gets fixed.
 *    These are all guaranteed PromQL syntax errors, so refusing costs one
 *    retry and buys an error the agent can act on instead of an opaque
 *    datasource parse failure.
 * 3. **Never rewrite the expression.** `classifyPromQL` returns the caller's
 *    text verbatim (trimmed), so the "the tool executes `verdict.statement`"
 *    invariant in adhocGuard.ts's header is satisfied trivially here: the
 *    scanned string and the executed string are the same object. InfluxQL has
 *    to collapse comments to separators because it splits on `;`; this doesn't
 *    split on anything, so it has nothing to earn by rewriting — and PromQL's
 *    `#` comments are handled by the datasource anyway.
 *
 * **This module is not a template for the next dialect.** Its lighter touch is
 * earned by one specific fact — PromQL has no write form — and nothing else. A
 * dialect that does have one (raw SQL, or a datasource plugin whose query model
 * reaches more than a query endpoint) needs a real statement classifier in the
 * shape of `classifyInfluxQL`, not this.
 */

import type { AdhocVerdict } from './adhocGuard.js';

/** What the scan ran out of input inside, if anything. Each is a refusal. */
export type PromqlUnterminatedKind = 'string literal' | 'raw string literal';

export interface PromqlScanResult {
  /**
   * The input with the *contents* of every string literal and every comment
   * blanked to spaces, delimiters kept. Structural checks (`;`, bracket
   * balance) run against this view so a `;` or `(` inside
   * `{path="/a;b("}` can never be read as syntax.
   */
  masked: string;
  /** True when everything outside comments is whitespace — nothing to run. */
  empty: boolean;
  /** Set when input ended inside a literal — always a refusal. */
  unterminated?: PromqlUnterminatedKind;
  /** First unbalanced bracket problem found, if any, phrased for the refusal message. */
  bracketProblem?: string;
}

type State = 'normal' | 'single' | 'double' | 'backtick' | 'comment';

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Single pass over the expression, tracking string and comment state, emitting
 * the masked view plus whatever made the text unclassifiable.
 *
 * PromQL has three string forms: `'…'` and `"…"` (backslash escapes) and
 * `` `…` `` (raw — a backslash is a literal backslash, so escapes must NOT be
 * honoured there or a trailing `\` would swallow the closing backtick). Comments
 * run from `#` to end of line. There is no block-comment form, which is why
 * nothing here looks for one.
 */
export function scanPromQL(expr: string): PromqlScanResult {
  let state: State = 'normal';
  let masked = '';
  let empty = true;
  const stack: Array<{ ch: string; index: number }> = [];
  let bracketProblem: string | undefined;

  const keep = (ch: string) => {
    masked += ch;
    if (!/\s/.test(ch)) empty = false;
  };
  const blank = () => {
    masked += ' ';
  };

  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i]!;
    switch (state) {
      case 'normal': {
        if (ch === '#') {
          state = 'comment';
          // A comment is a token separator, not nothing — same reasoning as
          // adhocGuard's. Blanked rather than kept so `#` can't read as syntax.
          blank();
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
          state = ch === "'" ? 'single' : ch === '"' ? 'double' : 'backtick';
          keep(ch);
          continue;
        }
        if (bracketProblem === undefined) {
          if (OPENERS[ch]) {
            stack.push({ ch, index: i });
          } else if (CLOSERS[ch]) {
            const top = stack.pop();
            if (!top) {
              bracketProblem = `a "${ch}" at position ${i} closes nothing`;
            } else if (OPENERS[top.ch] !== ch) {
              bracketProblem = `a "${top.ch}" at position ${top.index} is closed by "${ch}" at position ${i}`;
            }
          }
        }
        keep(ch);
        continue;
      }
      case 'single':
      case 'double':
      case 'backtick': {
        // Raw (backtick) strings have no escape sequences at all.
        if (state !== 'backtick' && ch === '\\' && i + 1 < expr.length) {
          blank();
          blank();
          i += 1;
          continue;
        }
        const closer = state === 'single' ? "'" : state === 'double' ? '"' : '`';
        if (ch === closer) {
          state = 'normal';
          keep(ch);
          continue;
        }
        blank();
        continue;
      }
      case 'comment': {
        if (ch === '\n') {
          state = 'normal';
          keep('\n');
          continue;
        }
        blank();
        continue;
      }
    }
  }

  if (bracketProblem === undefined && stack.length > 0) {
    const open = stack[0]!;
    bracketProblem = `a "${open.ch}" at position ${open.index} is never closed`;
  }

  const unterminated: PromqlUnterminatedKind | undefined =
    state === 'backtick' ? 'raw string literal' : state === 'single' || state === 'double' ? 'string literal' : undefined;

  return {
    masked,
    empty,
    ...(unterminated ? { unterminated } : {}),
    ...(bracketProblem !== undefined ? { bracketProblem } : {}),
  };
}

/**
 * Classifies one caller-supplied PromQL/MetricsQL expression as runnable, or
 * refused with a reason naming the specific problem. On success the returned
 * `statement` is the caller's text verbatim (trimmed) — see rule 3 in the
 * header.
 */
export function classifyPromQL(raw: string): AdhocVerdict {
  const scan = scanPromQL(raw);

  if (scan.unterminated) {
    return {
      allowed: false,
      reason:
        `Expression ends inside an unterminated ${scan.unterminated} — it can't be classified as a single ` +
        'expression, so it is refused rather than run. Close the quote.',
    };
  }
  if (scan.empty) {
    return { allowed: false, reason: 'Expression is empty (or contained only # comments).' };
  }
  if (scan.bracketProblem) {
    return {
      allowed: false,
      reason:
        `Expression has unbalanced brackets — ${scan.bracketProblem}. That is always a PromQL syntax error, so ` +
        'it is refused here rather than sent on for the datasource to reject.',
    };
  }
  if (scan.masked.includes(';')) {
    return {
      allowed: false,
      reason:
        'Expression contains ";". PromQL has no statement separator, so this is either a syntax error or an ' +
        'attempt to run two queries in one call. Run one expression per call so each has its own audit record ' +
        'and Explore URL. (Semicolons inside string literals and # comments do not count.)',
    };
  }

  return { allowed: true, statement: raw.trim() };
}

/** Upper bound on `stepSeconds`, purely to keep an obvious typo (a step in ms) from becoming a one-point query. */
export const MAX_STEP_SECONDS = 86_400;

export interface PromqlStepPlan {
  stepMs: number;
  /** Points the step implies over the window — `floor(span/step) + 1`, matching Prometheus's inclusive range. */
  points: number;
}

/**
 * Turns a caller-supplied `stepSeconds` into the step actually sent, refusing a
 * step that would ask for more points than MAX_DATA_POINTS allows.
 *
 * There is deliberately no default and no inference. The step is load-bearing
 * for every range-vector function (`rate`, `increase`, `delta`,
 * `count_over_time`), and issue #200 is a full account of what a silently
 * chosen one costs: a replay at a step the caller didn't pick reported ~0.75
 * errors/minute from a counter that had been flat for eight days, and several
 * layers of analysis were built on that number before anyone noticed the step
 * was the whole signal. An inferred step here would reproduce that in a tool
 * whose entire premise is that the caller is iterating on the query.
 *
 * The point budget is a real cap, not a formality: `stepSeconds: 1` over the
 * default 720h max lookback is 2.6M evaluation points. Prometheus itself
 * refuses above 11k, but VictoriaMetrics does not necessarily, and this cap is
 * the same MAX_DATA_POINTS every other query here answers to.
 */
export function resolvePromqlStep(args: {
  fromMs: number;
  toMs: number;
  stepSeconds: number;
  maxDataPoints: number;
}): PromqlStepPlan {
  const { fromMs, toMs, stepSeconds, maxDataPoints } = args;
  const stepMs = Math.round(stepSeconds * 1000);
  const spanMs = toMs - fromMs;
  const points = Math.floor(spanMs / stepMs) + 1;
  if (points > maxDataPoints) {
    // Name the smallest step that fits rather than just the failure: the caller
    // asked for a resolution, and the actionable answer is the finest one this
    // window can carry.
    const minStepSeconds = Math.ceil(spanMs / (maxDataPoints - 1) / 1000);
    throw new Error(
      `stepSeconds=${stepSeconds} over a ${(spanMs / 1000).toFixed(0)}s window asks for ${points} evaluation ` +
        `points, above MAX_DATA_POINTS=${maxDataPoints}. Use stepSeconds >= ${minStepSeconds}, or narrow the window.`,
    );
  }
  return { stepMs, points };
}
