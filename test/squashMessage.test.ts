import { describe, expect, it } from 'vitest';
import { parser } from '@conventional-commits/parser';

/**
 * Pins the parser behavior `.github/workflows/pr-message.yml` exists to enforce.
 *
 * This repo squash-merges with the PR title as the commit subject and the PR
 * *description* as the commit body, and release-please parses the whole thing with
 * this exact package (it pins `@conventional-commits/parser` at the same `^0.4.1`
 * we do). A commit it can't parse is not an error it reports — it is silently
 * counted as absent, which drops the CHANGELOG entry, and drops the whole release
 * when that commit is the only one since the last tag. That is #253.
 *
 * These cases are not documenting the Conventional Commits *spec*; they document an
 * artifact of this parser's PEG grammar, which is why they are pinned rather than
 * reimplemented in the check. If a dependency bump changes any of them, this test
 * is the thing that says so — and `checkSquashMessage.mjs`'s advice about
 * indentation stops being true.
 */
function parses(message: string): boolean {
  try {
    parser(message);
    return true;
  } catch {
    return false;
  }
}

const body = (line: string) => `fix: a subject\n\n${line}`;

describe('squash message parseability', () => {
  it('accepts an ordinary conventional commit', () => {
    expect(parses('fix: a subject\n\nA plain prose body.')).toBe(true);
  });

  it('rejects a subject with no conventional type prefix', () => {
    expect(parses('make the thing work\n\nbody')).toBe(false);
  });

  // The column-1 trap. A body line beginning with a bare word immediately
  // followed by `(` is read as a header's `type(scope)`, so the paren must close
  // on that line with nothing nested inside it.
  it('rejects a column-1 word( with a nested paren — the #253 shape', () => {
    expect(parses(body("process.on('uncaughtException', (err) => {"))).toBe(false);
  });

  it('rejects a column-1 word( left unclosed', () => {
    expect(parses(body('foo(bar'))).toBe(false);
  });

  it('accepts a column-1 word( whose paren closes cleanly', () => {
    expect(parses(body('foo(bar) and more text'))).toBe(true);
  });

  // Each of these is a fix checkSquashMessage.mjs actually recommends, so each
  // one failing would make the check's advice wrong rather than merely stale.
  it('accepts the same line indented by one space', () => {
    expect(parses(body("  process.on('uncaughtException', (err) => {"))).toBe(true);
  });

  it('accepts a space between the word and the paren', () => {
    expect(parses(body('foo (bar(baz))'))).toBe(true);
  });

  it('accepts a line that starts with the paren itself', () => {
    expect(parses(body('([#246](https://example.test/246))'))).toBe(true);
  });

  // Why the check can't just look for fenced code: backticks are not a shelter,
  // and release-please's own PR bodies are full of nested parens that are fine.
  it('rejects a nested paren even inside backticks', () => {
    expect(parses(body('`foo(bar(baz))`'))).toBe(false);
  });

  it("accepts release-please's own changelog bullet shape", () => {
    expect(
      parses(
        body('* resolve the thing ([#246](https://example.test/246)) ([3657d45](https://example.test/c))'),
      ),
    ).toBe(true);
  });
});
