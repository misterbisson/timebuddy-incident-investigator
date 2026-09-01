// Guards the one property of the auto-updater that must never regress: it
// stays completely inert unless the app is packaged. Run under an
// `electron test/...` invocation the app is unpackaged (app.isPackaged ===
// false), which stands in for the dev/CI case, and proves that guard
// short-circuits before electron-updater is ever touched. If this started
// returning a live updater here, a dev run would try to check for updates
// against an app-update.yml that doesn't exist. Run with:
//   electron test/updater.test.js --user-data-dir=<dir>
//
// Scope note: setupAutoUpdater used to refuse isMcpMode outright, so passing
// `true` below once exercised a second, independent guard. It no longer does —
// updater.js now runs in that mode too (stderr-only logger, no dialog, no
// quitAndInstall, one elected checker per interval). The isMcpMode:true case is
// therefore kept as a regression test that the PACKAGED guard alone still
// covers every mode, not as coverage of MCP-mode behavior — which nothing here
// can reach, since it all lives past the app.isPackaged return.
//
// That behavior is covered by test/updaterBehavior.test.js, which stubs
// `electron` instead of running under it and so can reach the packaged
// branches. Prefer adding cases there: this file is not run by CI at all (the
// electron-mcp-server job runs only test/mcpServerMode.mjs), while that one is.
const assert = require('node:assert');
const { app } = require('electron');

app.whenReady().then(() => {
  try {
    // Precondition: an `electron test/...` run is not a packaged app, so this
    // whole file exercises the unpackaged path. (A packaged build can't be
    // driven this way, so the packaged branch is covered by real installs.)
    assert.strictEqual(app.isPackaged, false, 'expected an unpackaged test run');

    const { setupAutoUpdater } = require('../src/updater.js');

    // Unpackaged → no-op regardless of mode.
    assert.strictEqual(setupAutoUpdater({ isMcpMode: false }), null, 'unpackaged GUI must no-op');
    assert.strictEqual(setupAutoUpdater({ isMcpMode: true }), null, 'unpackaged --mcp-server must no-op');
    assert.strictEqual(setupAutoUpdater(), null, 'default args must no-op');

    // The guard must short-circuit BEFORE the lazy require, so electron-updater
    // and its transitive deps are never even loaded on the unpackaged path.
    assert.ok(
      !Object.keys(require.cache).some((p) => p.includes(`${require('node:path').sep}electron-updater${require('node:path').sep}`)),
      'electron-updater must not be loaded when setupAutoUpdater no-ops',
    );

    console.log('updater.test.js: OK');
    app.exit(0);
  } catch (err) {
    console.error('updater.test.js: FAIL');
    console.error(err);
    app.exit(1);
  }
});
