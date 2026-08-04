// Guards the one property of the auto-updater that must never regress: it
// stays completely inert unless the app is a packaged GUI build. Run under an
// `electron test/...` invocation the app is unpackaged (app.isPackaged ===
// false), which stands in for the dev/CI case; combined with the isMcpMode
// branch it proves both guards short-circuit before electron-updater is ever
// touched. If this ever started returning a live updater here, a dev run or —
// worse — an --mcp-server session (whose stdout is the MCP JSON-RPC channel)
// could pop a restart dialog or relaunch itself mid-session. Run with:
//   electron test/updater.test.js --user-data-dir=<dir>
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

    // The guards must short-circuit BEFORE the lazy require, so electron-updater
    // is never even loaded on these paths — the property that keeps it out of
    // the --mcp-server process entirely.
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
