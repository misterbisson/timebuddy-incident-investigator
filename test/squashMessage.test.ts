import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parser } from '@conventional-commits/parser';
// Plain .mjs with no type declarations. tsconfig excludes test/, so this is never
// typechecked and vitest strips types without checking — don't add a @ts-expect-error
// here, nothing evaluates it and it would only imply a guarantee that doesn't exist.
import { wrapBody } from '../scripts/wrapSquashBody.mjs';

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

/**
 * The wrap is the other half of the check's fidelity: what release-please parses is
 * the body *after* GitHub re-wraps it, and wrapping is what moves a token into
 * column 1 in the first place. These cases pin the emulation's shape. The
 * byte-for-byte agreement with real merged bodies (#253, #246, #249, #250) is what
 * established the 72/fence rules; reproducing it here would mean fetching commits,
 * so what is pinned is the behavior those commits demonstrated.
 */
describe('GitHub squash-body wrap emulation', () => {
  // Each case below corresponds to a real merged commit whose body the emulation
  // disagreed with at some point. `wrapBody` reproduces 63 of the 65 observable
  // merged bodies in this repo; the assertions here stand in for that corpus, which
  // can't be checked from a unit test without network and git access. A mutation that
  // breaks any of them puts the check back to parsing text GitHub will not commit.

  it('fills greedily at exactly 72 columns, not 71 or 73', () => {
    const w72 = 'a'.repeat(70) + ' b'; // 72 chars exactly
    expect([...w72].length).toBe(72);
    expect(wrapBody(w72)).toBe(w72);

    const w73 = 'a'.repeat(71) + ' b'; // 73 chars — must wrap
    expect([...w73].length).toBe(73);
    expect(wrapBody(w73)).toBe(`${'a'.repeat(71)}\nb`);
  });

  // #239: GitHub splits on runs of whitespace and rejoins with single spaces.
  it('collapses runs of ASCII whitespace when it wraps a line', () => {
    const line = `${'word '.repeat(20)}alpha  beta`;
    expect(wrapBody(line)).not.toContain('alpha  beta');
    expect(wrapBody(line)).toContain('alpha beta');
  });

  // #238/#225: Ruby's \s excludes NBSP, so those stay glued. This is why the split
  // is an explicit ASCII class rather than /\s+/.
  it('does not collapse a non-breaking space', () => {
    const line = `${'word '.repeat(20)}alpha\u00A0\u00A0beta`;
    expect(wrapBody(line)).toContain('alpha\u00A0\u00A0beta');
  });

  // #242: when a line BEGINS with an over-width word, the empty accumulator is pushed
  // like any other line, so GitHub emits a leading blank. Re-adding an
  // empty-accumulator guard drops corpus fidelity from 63/65 to 62/65 on exactly #242.
  it('emits a blank line when a line begins with an over-width word', () => {
    const url = `https://example.test/${'x'.repeat(90)}`;
    expect(wrapBody(`${url} tail`).split('\n')).toEqual(['', url, 'tail']);
  });

  it('does not emit a blank line when the over-width word is mid-line', () => {
    const url = `https://example.test/${'x'.repeat(90)}`;
    expect(wrapBody(`short lead ${url} tail`).split('\n')).toEqual(['short lead', url, 'tail']);
  });

  it('counts characters, not bytes — an em-dash is one column', () => {
    const line = `${'—'.repeat(36)}${'a'.repeat(36)}`;
    expect([...line].length).toBe(72);
    expect(wrapBody(line)).toBe(line);
  });

  it('leaves fenced code blocks untouched, however long', () => {
    const long = "process.on('uncaughtException', (err) => { console.error('a very long line indeed, well past the limit'); });";
    const body = ['```js', long, '```'].join('\n');
    expect(wrapBody(body)).toBe(body);
  });

  it('recognizes an indented fence', () => {
    const long = `${'word '.repeat(30)}end`;
    const body = ['  ```', long, '  ```'].join('\n');
    expect(wrapBody(body)).toBe(body);
  });

  it('normalizes CRLF', () => {
    expect(wrapBody('a\r\nb')).toBe('a\nb');
  });

  // The regression this change is about: fine as typed, broken once wrapped.
  it('turns a mid-paragraph inline-code token into a column-1 failure', () => {
    const para =
      'release-please does not stop at the PEG parse. It runs the tree through ' +
      '`toConventionalChangelogFormat(parser(msg))`, and a commit that trips either ' +
      'half is counted as absent rather than reported.';
    expect(parses(`fix: s\n\n${para}`)).toBe(true);
    expect(parses(`fix: s\n\n${wrapBody(para)}`)).toBe(false);
  });
});

describe('what the check tells people to do about it', () => {
  // These pin the remediation text in checkSquashMessage.mjs. An earlier version led
  // with "indent the line by one space", which is false for prose: GitHub strips the
  // indentation of any line it has to wrap (confirmed against #257's own merged body).
  const offender = 'foo(bar(baz))';

  it('indentation does NOT save an over-width prose line', () => {
    const line = `  ${'word '.repeat(14)}${offender} tail`;
    expect([...line].length).toBeGreaterThan(72);
    expect(parses(`fix: s\n\n${wrapBody(line)}`)).toBe(false);
  });

  it('indentation DOES save a line inside a fence, which is never wrapped', () => {
    const body = ['```js', `  ${'word '.repeat(14)}${offender} tail`, '```'].join('\n');
    expect(parses(`fix: s\n\n${wrapBody(body)}`)).toBe(true);
  });

  it('a space before the paren survives the wrap at every offset', () => {
    for (let pad = 0; pad < 40; pad++) {
      const line = `${'word '.repeat(pad)}foo (bar(baz)) tail`.trim();
      expect(parses(`fix: s\n\n${wrapBody(line)}`)).toBe(true);
    }
  });
});

/**
 * The check is only useful if it actually runs, and an earlier version could silently
 * not run: it exported `wrapBody` and gated `main()` on a main-module comparison,
 * which is false whenever the path is percent-encoded or symlink-resolved differently
 * from `process.argv[1]`. The result was exit 0 with an empty log — a green step that
 * checked nothing, the same silent pass the whole check exists to prevent. The guard
 * is gone (see scripts/wrapSquashBody.mjs), and these run the real script the way CI
 * does rather than importing it, from several cwds and path spellings.
 */
describe('the checker runs as a program', () => {
  const script = fileURLToPath(new URL('../scripts/checkSquashMessage.mjs', import.meta.url));
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const badBody = "process.on('uncaughtException', (err) => {";

  function run(args: { path: string; cwd: string; title?: string; body?: string; author?: string }): number {
    try {
      execFileSync(process.execPath, [args.path], {
        cwd: args.cwd,
        env: {
          ...process.env,
          PR_TITLE: args.title ?? 'fix: s',
          PR_BODY: args.body ?? badBody,
          PR_AUTHOR: args.author ?? 'someone',
        },
        stdio: 'ignore',
      });
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? -1;
    }
  }

  it('fails a bad message when invoked by relative path from the repo root, as CI does', () => {
    expect(run({ path: 'scripts/checkSquashMessage.mjs', cwd: repoRoot })).toBe(1);
  });

  it('fails a bad message when invoked by absolute path from an unrelated cwd', () => {
    expect(run({ path: script, cwd: tmpdir() })).toBe(1);
  });

  it('passes a clean message', () => {
    expect(run({ path: script, cwd: repoRoot, body: 'An ordinary prose body.' })).toBe(0);
  });

  it('passes, without blocking, a bot-authored bad message', () => {
    expect(run({ path: script, cwd: repoRoot, author: 'dependabot[bot]' })).toBe(0);
  });

  it('fails a non-conventional title', () => {
    expect(run({ path: script, cwd: repoRoot, title: 'no type prefix', body: 'fine' })).toBe(1);
  });
});
