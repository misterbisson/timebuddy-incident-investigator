/**
 * Fails a PR whose squash commit message release-please won't be able to parse.
 *
 * Why this exists, and why it isn't covered by the PR-title convention already
 * documented in CLAUDE.md: this repo squash-merges with
 * `squash_merge_commit_title: PR_TITLE` and `squash_merge_commit_message: PR_BODY`,
 * so the PR *description* becomes the commit body verbatim. release-please parses
 * the whole message — body included — with the strict PEG grammar in
 * `@conventional-commits/parser`, and one unparseable line rejects the entire
 * commit. It doesn't fail loudly when that happens; it logs `commit could not be
 * parsed`, counts the commit as absent, and moves on:
 *
 *   - with other parseable commits in the window, the commit's CHANGELOG line is
 *     silently dropped (it still ships);
 *   - when it's the only commit since the last release, no release PR opens at all,
 *     and release.yml's `version` job still reports success.
 *
 * That second case is #253: its body contained a JS fence whose first line was
 * `process.on('uncaughtException', (err) => {`, and v0.12.0's successor never
 * appeared. Nothing in CI was red.
 *
 * The trap, concretely: a body line starting in **column 1** with a bare word
 * immediately followed by `(` is read as a conventional-commit header's
 * `type(scope)`, so that `(` must close on the same line with no second `(` inside
 * it. Indentation defeats it entirely — ` process.on('x', (err) => {` parses fine,
 * as does `thing (a (b))` (space before the paren) and any line starting with `(`.
 * Backticks do not help: `` `foo(bar(baz))` `` fails.
 *
 * We run the real parser rather than re-implementing that rule, because the rule is
 * an artifact of a PEG grammar rather than a spec — an approximation of it would
 * drift from whatever release-please actually does, which is the only thing that
 * matters here.
 *
 * Known gap: GitHub re-wraps the body when it builds the squash commit, and
 * wrapping can push a token to column 1 that wasn't there in the PR description.
 * We check the description as written, since the widths observed on real commits
 * here (74/80/88) don't fit one greedy fill and emulating them would be guesswork
 * that fails PRs for a wrap that may not happen. Fenced code — the realistic case,
 * and the one that bit us — is already column-1 and short, so it is caught as-is.
 */
import { parser } from '@conventional-commits/parser';

const title = process.env.PR_TITLE ?? '';
const body = process.env.PR_BODY ?? '';

if (!title.trim()) {
  console.error('No PR title provided (PR_TITLE is empty).');
  process.exit(1);
}

// Exactly how GitHub assembles it: title, blank line, body.
const message = body.trim() ? `${title}\n\n${body}` : title;

try {
  parser(message);
} catch (err) {
  const message_ = err && err.message ? err.message : String(err);
  const where = /at (\d+):(\d+)/.exec(message_);
  const lines = message.split('\n');

  console.error('release-please will NOT be able to parse this PR\'s squash commit message.\n');
  console.error(`  ${message_.split('\n')[0]}\n`);

  if (where) {
    const lineNo = Number(where[1]);
    const colNo = Number(where[2]);
    const offending = lines[lineNo - 1] ?? '';
    const label = lineNo === 1 ? 'PR title' : `PR body line ${lineNo - 2}`;
    console.error(`  ${label}:`);
    console.error(`    ${offending}`);
    console.error(`    ${' '.repeat(Math.max(0, colNo - 1))}^`);
    console.error('');
  }

  console.error('Consequence if merged as-is: release-please drops this commit entirely.');
  console.error('Its CHANGELOG entry disappears, and if it is the only commit since the');
  console.error('last release, no release PR is opened at all. Nothing turns red.\n');

  if (where && Number(where[1]) === 1) {
    console.error('The title is not a Conventional Commit. It needs a type prefix —');
    console.error('feat:, fix:, chore:, docs:, refactor:, test:, build:, ci: — optionally');
    console.error('with a scope, e.g. `fix(electron): ...`. Only feat:/fix: (or a breaking');
    console.error('change) trigger a release; the rest still need to parse.');
  } else {
    console.error('Usual cause: a body line starting in column 1 with a word immediately');
    console.error('followed by "(" — e.g. `process.on(\'x\', (err) => {` inside a code fence.');
    console.error('It is read as a conventional-commit `type(scope)`, so that "(" must close');
    console.error('on the same line with nothing nested inside it.\n');
    console.error('Fixes, cheapest first — edit the PR description (not the branch):');
    console.error('  * Indent the line by one space. Indentation alone defeats the rule and');
    console.error('    leaves fenced code otherwise untouched.');
    console.error('  * Or put a space before the "(": `process.on (...)`.');
    console.error('  * Or drop the fence and describe the code in prose.');
  }
  process.exit(1);
}

console.log('Squash commit message parses cleanly — release-please will see this commit.');
