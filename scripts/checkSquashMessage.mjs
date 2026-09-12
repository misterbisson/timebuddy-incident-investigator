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
 * unemulatable "known gap"; that was wrong on both counts. The wrap is a
 * deterministic 72-column greedy fill that leaves fenced code blocks alone,
 * reproduced byte-for-byte against the merged bodies of #253, #246, #249 and #250.
 * (The line widths that made it look irregular were a measurement error: `awk
 * length` counts bytes, so an em-dash reads as 3, and the over-72 lines were all
 * inside fences.)
 *
 * Getting this right inverts which case is dangerous. Fenced code is *exempt* from
 * wrapping, so a fence is only a hazard when it is already column-1 — the #253
 * shape. Ordinary prose is what gets re-wrapped, so a paragraph containing an
 * inline-code token like `toConventionalChangelogFormat(parser(msg))` is fine as
 * typed and fails once the wrap lands that token in column 1. No merged PR in the
 * last 60 hit that, so it was latent rather than active — but it is this repo's own
 * prose style, and checking the wrapped form costs nothing and cannot produce a
 * false positive, since wrapping never moves a column-1 token off column 1.
 */
import { parser } from '@conventional-commits/parser';

/**
 * GitHub's squash-body wrap: greedy fill at 72 columns, counted in characters, with
 * ``` fenced blocks passed through untouched. A word longer than the width is
 * emitted on its own overlong line rather than broken (this is what puts a bare
 * 98-character URL on a line of its own in release-please's own commits).
 */
export function wrapBody(body, width = 72) {
  const out = [];
  let inFence = false;
  for (const raw of body.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      out.push(raw);
      continue;
    }
    if (inFence || raw.trim() === '' || [...raw].length <= width) {
      out.push(raw);
      continue;
    }
    let cur = '';
    for (const word of raw.split(' ')) {
      if (cur === '') cur = word;
      else if ([...cur].length + 1 + [...word].length <= width) cur += ' ' + word;
      else {
        out.push(cur);
        cur = word;
      }
    }
    out.push(cur);
  }
  return out.join('\n');
}

// Only run the check when invoked directly, so the wrap is importable by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

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
    say('Fixes, cheapest first — edit the PR description:');
    say('  * Indent the line by one space. Indentation alone defeats the rule, and');
    say('    indented lines are left alone by the wrap.');
    say('  * Or put a space before the "(": `process.on (...)`.');
    say('  * Or reword so the token cannot begin a line.');
  }

  if (isBot) {
    say('\nNot failing this check: the description is bot-generated and would be');
    say('regenerated on the next rebase. Expect this commit to be missing from the');
    say('CHANGELOG, and add its line by hand on the release PR before merging.');
    return;
  }
  process.exit(1);
}
