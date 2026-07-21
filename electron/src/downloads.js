const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');

// The two filesystem security controls behind the Activity window's "Export
// CSV" / "Capture screenshot" buttons, factored out of main.js so they can be
// unit-tested without launching Electron (main.js just binds them to
// app.getPath('downloads') and the IPC handlers). Both defend a renderer-facing
// boundary, so a silent regression in either is exactly what a test needs to
// catch.

// Writes `data` into `dir` under `filename`, without ever clobbering an
// existing file: on a name collision it appends " (2)", " (3)", … until one is
// free. The `wx` flag makes each attempt fail rather than overwrite if the name
// appeared between attempts, so this is race-free (no check-then-write TOCTOU
// gap). Only path.basename(filename) is ever used, so an engine-suggested name
// containing path separators or `..` can never write outside `dir`.
async function writeToDir(dir, filename, data) {
  await mkdir(dir, { recursive: true });
  const safe = path.basename(filename);
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext);
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`;
    const full = path.join(dir, name);
    try {
      await writeFile(full, data, { flag: 'wx' });
      return full;
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
  }
}

// True iff `candidate` resolves to `dir` itself or a path strictly inside it.
// The `+ path.sep` is load-bearing: a bare startsWith(dir) would also accept a
// sibling directory whose name merely begins with dir's (e.g. a "Downloads-evil"
// next to "Downloads"), letting a crafted reveal path escape the intended scope.
function isWithinDirectory(dir, candidate) {
  const resolved = path.resolve(String(candidate));
  return resolved === dir || resolved.startsWith(dir + path.sep);
}

module.exports = { writeToDir, isWithinDirectory };
