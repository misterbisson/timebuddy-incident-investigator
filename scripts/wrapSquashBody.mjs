/**
 * GitHub's re-wrap of a PR description into a squash commit body.
 *
 * Split out of checkSquashMessage.mjs so that script can be an unconditional
 * program. It used to export this function and gate its own `main()` on a
 * main-module check, which is a trap: `import.meta.url` is percent-encoded *and*
 * symlink-resolved, while `process.argv[1]` is neither, so on macOS — where
 * os.tmpdir() lives under the /var -> /private/var symlink — even a
 * pathToFileURL-based comparison is false, and the checker then exits 0 having done
 * nothing. A green step with an empty log is the exact silent pass the checker
 * exists to prevent, so the guard is gone rather than patched.
 */
/*
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
    // Split on runs of ASCII whitespace, NBSP excluded (Ruby's \s excludes it, and
    // #238/#225 show GitHub agreeing). Dropping the indentation of an over-width line
    // falls out of this: the leading '' is absorbed by the cur === '' branch below.
    const words = raw.split(/[ \t\r\f\v]+/);
    let cur = '';
    for (const word of words) {
      const fits = [...cur].length + (cur === '' ? 0 : 1) + [...word].length <= width;
      if (fits) cur = cur === '' ? word : `${cur} ${word}`;
      else {
        // No empty-accumulator guard: an over-width first word is preceded by a
        // blank line, matching GitHub (#242).
        out.push(cur);
        cur = word;
      }
    }
    out.push(cur);
  }
  return out.join('\n');
}

