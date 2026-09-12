/**
 * Fails a PR whose squash commit message release-please won't be able to parse.
 *
 * Why this exists, and why it isn't covered by the PR-title convention already
 * documented in CLAUDE.md: this repo squash-merges with
 * `squash_merge_commit_title: PR_TITLE` and `squash_merge_commit_message: PR_BODY`,
 * so the PR *description* becomes the commit body. release-please parses the whole
 * message — body included — with the strict PEG grammar in
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
 * it. Indentation defeats it entirely — `  process.on('x', (err) => {` parses fine,
 * as does `thing (a (b))` (space before the paren) and any line starting with `(`.
 * Backticks do not help: `` `foo(bar(baz))` `` fails.
 *
 * We run the real parser rather than re-implementing that rule, because the rule is
 * an artifact of a PEG grammar rather than a spec — an approximation of it would
 * drift from whatever release-please actually does, which is the only thing that
 * matters here.
 *
 * **We check the body as GitHub will commit it, not as it was typed.** GitHub
 * re-wraps the description when it builds the squash commit, and wrapping moves
 * tokens *to* column 1 that weren't there — which is the whole hazard. An earlier
 * version of this script checked the raw description and called the wrap an
 * unemulatable "known gap"; that was wrong. The wrap is a deterministic 72-column
 * greedy fill that leaves fenced code blocks alone. (The line widths that first made
 * it look irregular were a measurement error: `awk length` counts bytes, so an
 * em-dash reads as 3, and the over-72 lines were all inside fences.)
 *
 * `wrapBody` is verified against every merged PR in this repo whose commit body is
 * observable — 63 of 65 reproduce byte-for-byte, the two misses being PRs that
 * predate the `squash_merge_commit_message: PR_BODY` setting and whose commit bodies
 * are therefore unrelated to their descriptions. Three details were each worth a real
 * commit's disagreement, so don't "simplify" them away:
 *
 *   - **Whitespace runs collapse** (#239). GitHub splits on runs of ASCII whitespace
 *     and rejoins with single spaces, so `a␠␠b` becomes `a␠b`. A plain `split(' ')`
 *     preserves the run and drifts. Note NBSP is *not* included — Ruby's `\s`
 *     excludes it, which is why #238/#225's `␠\u00A0-\u00A0␠` sequences stay glued.
 *   - **An over-width first word gets a blank line before it** (#242). There is no
 *     empty-accumulator special case: the empty accumulator is pushed like any other
 *     line.
 *   - **Leading indentation is dropped on an over-width line**, falling out of the
 *     same split. This one is load-bearing for the advice below.
 *
 * Getting this right inverts which case is dangerous. Fenced code is *exempt* from
 * wrapping, so a fence is only a hazard when it is already column-1 — the #253 shape.
 * Ordinary prose is what gets re-wrapped, so a paragraph containing an inline-code
 * token like `toConventionalChangelogFormat(parser(msg))` is fine as typed and fails
 * once the wrap lands that token in column 1. No merged PR has hit that, so it is
 * latent rather than active — but it is this repo's own prose style.
 *
 * On false positives: the honest claim is *not* that wrapping can't cause one. It is
 * that a false positive needs **this emulation** to create a column-1 token that
 * **GitHub's** wrap would not, which is bounded by the fidelity above rather than by
 * any property of wrapping in general. `test/squashMessage.test.ts` pins the three
 * details, because the corpus check lives here in a comment and a mutation that
 * breaks one is otherwise invisible.
 */
import { parser } from '@conventional-commits/parser';
import { wrapBody } from './wrapSquashBody.mjs';

function main() {
  const title = process.env.PR_TITLE ?? '';
  const rawBody = process.env.PR_BODY ?? '';
  const author = process.env.PR_AUTHOR ?? '';

  if (!title.trim()) {
    console.error('No PR title provided (PR_TITLE is empty).');
    process.exit(1);
  }

  const body = wrapBody(rawBody);
  // Exactly how GitHub assembles it: title, blank line, wrapped body.
  const message = body.trim() ? `${title}\n\n${body}` : title;

  try {
    parser(message);
  } catch (err) {
    report(err, message, author);
    return;
  }

  console.log('Squash commit message parses cleanly — release-please will see this commit.');
}

function report(err, message, author) {
  // A bot's description is regenerated from upstream release notes on every rebase,
  // so "edit the PR body" is not a fix that survives — and with `strict: true`
  // requiring an up-to-date branch, rebases are routine. Blocking here would wedge
  // dependency updates (including security ones) on a problem the bot will simply
  // re-introduce. So: report it loudly, don't block. The cost is the known
  // changelog-drop hazard, which is recoverable by hand on the release PR; the cost
  // of the alternative is not shipping the bump at all.
  const isBot = /\[bot\]$/.test(author) || author === 'dependabot' || author === 'app/dependabot';
  const say = isBot ? console.warn : console.error;
  const headline = isBot
    ? 'WARNING: release-please will not be able to parse this PR\'s squash commit message.'
    : 'release-please will NOT be able to parse this PR\'s squash commit message.';

  const detail = err && err.message ? err.message : String(err);
  const where = /at (\d+):(\d+)/.exec(detail);
  const lines = message.split('\n');

  say(`${headline}\n`);
  say(`  ${detail.split('\n')[0]}\n`);

  if (where) {
    const lineNo = Number(where[1]);
    const colNo = Number(where[2]);
    const offending = lines[lineNo - 1] ?? '';
    const label = lineNo === 1 ? 'PR title' : `commit body line ${lineNo - 2}`;
    say(`  ${label}:`);
    say(`    ${offending}`);
    say(`    ${' '.repeat(Math.max(0, colNo - 1))}^`);
    say('');
    if (lineNo > 1) {
      say('  (Line numbers are into the commit body *after* GitHub re-wraps the');
      say('   description at 72 columns, so this line may not appear verbatim in');
      say('   the PR description.)\n');
    }
  }

  say('Consequence if merged as-is: release-please drops this commit entirely.');
  say('Its CHANGELOG entry disappears, and if it is the only commit since the');
  say('last release, no release PR is opened at all. Nothing turns red.\n');

  if (where && Number(where[1]) === 1) {
    say('The title is not a Conventional Commit. It needs a type prefix —');
    say('feat:, fix:, chore:, docs:, refactor:, test:, build:, ci: — optionally');
    say('with a scope, e.g. `fix(electron): ...`. Only feat:/fix: (or a breaking');
    say('change) trigger a release; the rest still need to parse.');
  } else {
    say('Usual cause: a line starting in column 1 with a word immediately followed');
    say('by "(" — e.g. `process.on(\'x\', (err) => {`. It is read as a conventional-');
    say('commit `type(scope)`, so that "(" must close on the same line with nothing');
    say('nested inside it. Note this can be a line the wrap created: an inline-code');
    say('token mid-paragraph can land in column 1 once the paragraph is re-wrapped.\n');
    say('Fixes — edit the PR description:');
    say('  * Put a space before the "(": `process.on (...)`. This is the reliable');
    say('    one: it survives the wrap, because a line may then start with "(",');
    say('    which is harmless, but never with the word.');
    say('  * Inside a ``` fence, indenting the line by one space also works — fences');
    say('    are not re-wrapped. Do NOT rely on indentation in prose: GitHub strips');
    say('    the indentation of any line it has to wrap.');
  }

  if (isBot) {
    say('\nNot failing this check: the description is bot-generated and would be');
    say('regenerated on the next rebase. Expect this commit to be missing from the');
    say('CHANGELOG, and add its line by hand on the release PR before merging.');
    return;
  }
  process.exit(1);
}

// No main-module guard: this file is only ever run as a program. See
// wrapSquashBody.mjs's header for why a guard here was actively dangerous.
main();
