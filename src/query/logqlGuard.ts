/**
 * Statement guard for model-authored LogQL against a Grafana `loki` datasource
 * (see tools/executeAdhocQuery.ts, and issue #264).
 *
 * ## Why this looks like promqlGuard.ts, and why that's earned rather than copied
 *
 * `promqlGuard.ts` says plainly that its lighter touch is not a template for
 * the next dialect: it is earned by one fact, that PromQL has no write form.
 * LogQL gets the same treatment because the same fact holds for it, checked
 * rather than assumed:
 *
 * - **The language has no write, delete, or DDL form.** A LogQL expression is a
 *   stream selector, optionally a pipeline of filter/parse/format stages, and
 *   optionally metric functions over that. Loki's write path (`/push`) and its
 *   deletion API (`/delete`) are separate HTTP endpoints that take no LogQL.
 * - **Grafana's Loki backend only reaches Loki's query endpoints.** Through
 *   `/api/ds/query` it issues `query` / `query_range` with the expression as a
 *   request *parameter*, never as part of a path, so no expression text can
 *   redirect the request at `/push`, `/delete`, or an admin endpoint.
 *
 * So, as for PromQL, read-only-ness is a property of the language and the
 * endpoints it reaches, not of the statement, and this guard asserts what it
 * can instead of pretending to classify reads from writes:
 *
 * 1. **One expression per call.** Same reason as PromQL: the audit record, the
 *    `provenance` marking, and the Explore URL are all one-per-call.
 * 2. **Refuse what it can't read as one expression.** Unterminated literal,
 *    unbalanced bracket, a top-level `;`, nothing but comments — each is a
 *    guaranteed LogQL syntax error, refused with a reason naming the problem.
 * 3. **Never rewrite.** The returned statement is the caller's text, trimmed,
 *    so the tool executes exactly the string that was scanned.
 *
 * ## One thing this adds: the log/metric split
 *
 * A LogQL expression is either a **log query** (returns lines) or a **metric
 * query** (returns series), and the two go to different tools — lines to
 * search_logs, series to execute_adhoc_query. That split is a property of the
 * grammar, not a heuristic: a log query is a stream selector plus an optional
 * pipeline, so it always begins with `{` (possibly parenthesized), while a
 * metric query always begins with a function, an aggregation, or a literal —
 * never with a selector. `kind` reports which, read off the masked text so a
 * `{` inside a string can't decide it.
 *
 * ## Reusing the PromQL scanner
 *
 * LogQL's lexer is PromQL's with pipeline stages added: the same `"…"`
 * (escaped) and `` `…` `` (raw) string forms, the same `#` line comments, the
 * same `()`/`[]`/`{}` brackets. So `scanPromQL` masks it correctly. The one
 * lexical difference is that LogQL has no single-quoted string, and that
 * makes the shared scan *stricter*, not looser: a stray `'` either reads as an
 * unterminated literal (refused here) or as a string Loki rejects as a syntax
 * error. That matters most for `line_format` / `label_format` templates, whose
 * `{{.field}}` braces sit inside a string and must never count as brackets.
 */

import type { AdhocVerdict } from './adhocGuard.js';
import { scanPromQL } from './promqlGuard.js';

/** Which kind of result a LogQL expression produces — see the header. */
export type LogqlKind = 'log' | 'metric';

export type LogqlVerdict =
  | { allowed: true; statement: string; kind: LogqlKind }
  | { allowed: false; reason: string };

/**
 * Reads the kind off the masked expression: strip leading whitespace and
 * opening parentheses, then a log query is the one left starting with `{`.
 */
function kindOf(masked: string): LogqlKind {
  return /^[\s(]*\{/.test(masked) ? 'log' : 'metric';
}

/**
 * Classifies one caller-supplied LogQL expression as runnable — with its
 * kind — or refused with a reason naming the specific problem.
 */
export function classifyLogQL(raw: string): LogqlVerdict {
  const scan = scanPromQL(raw);

  if (scan.unterminated) {
    return {
      allowed: false,
      reason:
        `Expression ends inside an unterminated ${scan.unterminated} — it can't be classified as a single ` +
        'expression, so it is refused rather than run. Close the quote (LogQL strings use "…" or `…`; there is ' +
        'no single-quoted form).',
    };
  }
  if (scan.empty) {
    return { allowed: false, reason: 'Expression is empty (or contained only # comments).' };
  }
  if (scan.bracketProblem) {
    return {
      allowed: false,
      reason:
        `Expression has unbalanced brackets — ${scan.bracketProblem}. That is always a LogQL syntax error, so ` +
        'it is refused here rather than sent on for the datasource to reject.',
    };
  }
  if (scan.masked.includes(';')) {
    return {
      allowed: false,
      reason:
        'Expression contains ";". LogQL has no statement separator, so this is either a syntax error or an ' +
        'attempt to run two queries in one call. Run one expression per call so each has its own audit record ' +
        'and Explore URL. (Semicolons inside string literals and # comments do not count.)',
    };
  }

  return { allowed: true, statement: raw.trim(), kind: kindOf(scan.masked) };
}

/**
 * The execute_adhoc_query view of classifyLogQL: metric queries only. A log
 * query is refused rather than run, because its result is lines, which this
 * tool's series-shaped result can't carry: parsed as series, a page of log
 * lines comes back as nothing at all.
 */
export function classifyLogQLMetric(raw: string): AdhocVerdict {
  const verdict = classifyLogQL(raw);
  if (!verdict.allowed) return verdict;
  if (verdict.kind === 'log') {
    return {
      allowed: false,
      reason:
        'This is a log query (it begins with a stream selector), which returns log lines rather than series. ' +
        'To count or rate its lines here, wrap it in a metric query — e.g. sum(count_over_time(<query> [1m])) ' +
        'or sum by (level) (rate(<query> [5m])).',
    };
  }
  return { allowed: true, statement: verdict.statement };
}
