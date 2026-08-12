const { app, dialog } = require('electron');

// Wires electron-updater into the packaged GUI app. On launch it checks the
// GitHub Releases feed (configured by electron-builder's `build.publish` block
// in package.json, which electron-builder bakes into app-update.yml at pack
// time — there is no feed URL to set here), downloads any newer version in the
// background, and once the download finishes offers the user a restart.
//
// Deliberately a no-op unless the app is packaged: an unpackaged dev checkout
// (`npm start`, the CI integration test) has no app-update.yml, so
// autoUpdater.checkForUpdates() would immediately error with "config not
// found". Nothing to update anyway when you're running from source.
//
// On --mcp-server mode: note that it is NOT headless, so "it can't show UI" is
// not the reason the updater stays off there. main.js calls buildMenu() before
// the mode branch, and --mcp-server opens a real Activity BrowserWindow on the
// first tool call, plus a Connections window via File > Connections… . The
// actual constraints are narrower, and each is handled here rather than by
// refusing the mode outright:
//
//   1. stdout IS the MCP JSON-RPC channel, so no updater output may ever reach
//      it — see the logger pinned to stderr below. This is the sharp one: it's
//      silent corruption of someone else's protocol stream, not a visible bug.
//
//   2. quitAndInstall() would tear down a session Claude Code/Desktop owns,
//      mid-conversation. Never called when isMcpMode; autoInstallOnAppQuit
//      applies the update on the next natural exit instead, which for an MCP
//      server is the end of every session — so the passive path is not a
//      degraded fallback here, it's the better one.
//
//   3. A modal restart prompt would interrupt an agent session that the user
//      may not even be watching. Suppressed in that mode.
//
// NOTE: being safe to *call* in --mcp-server mode is not the same as being safe
// to *enable* there, and main.js still doesn't. There is no
// requestSingleInstanceLock, so every Claude Code session/worktree spawns its
// own process — a routine developer machine was observed running 11 at once.
// Turning this on for all of them means N concurrent checks and up to N
// concurrent ~120MB downloads racing on one fixed cache path. Enabling it needs
// an election first (a timestamp file in userData, or gating on a GUI window
// actually being open); this module is merely ready for that day rather than
// being what blocks it.
//
// Platform note: macOS auto-update (Squirrel.Mac) needs BOTH a code-signed app
// AND a `zip` artifact in the release — a `dmg` alone is not updater-consumable
// (electron-updater's MacUpdater throws ERR_UPDATER_ZIP_FILE_NOT_FOUND). The
// release pipeline signs + notarizes via electron-builder's built-in
// mac.notarize, and package.json's build.mac.target emits the zip that
// latest-mac.yml points at;
// do not remove that zip target or macOS updates silently break. Windows
// (nsis) and Linux (AppImage) auto-update work here too — though build.win is
// not yet code-signing configured, so a Windows update currently installs an
// unsigned build. An unsigned local dev build simply never finds a valid
// update and no-ops via the error handler below.
function setupAutoUpdater({ isMcpMode = false } = {}) {
  if (!app.isPackaged) return null;

  // Lazy require: keeps electron-updater and its transitive deps out of the
  // process entirely on the unpackaged path, loaded only once we've decided we
  // actually intend to check for updates.
  const { autoUpdater } = require('electron-updater');

  // electron-updater's default logger is electron-log when that package can be
  // resolved and bare `console` otherwise — and nothing here depends on
  // electron-log, so the console fallback is what's live. Its info/debug levels
  // write to STDOUT, which in --mcp-server mode is the JSON-RPC channel: one
  // interleaved progress line silently corrupts the session rather than failing
  // loudly. Pin every level to stderr so no updater output can reach stdout in
  // either mode, and so this stays true if a dependency bump changes which
  // logger electron-updater picks by default.
  autoUpdater.logger = {
    info: (...args) => console.error('[auto-update]', ...args),
    warn: (...args) => console.error('[auto-update]', ...args),
    error: (...args) => console.error('[auto-update]', ...args),
    // Dropped rather than routed to stderr: electron-updater's debug level is
    // per-chunk download progress, which would bury the lines worth reading.
    debug: () => {},
  };

  // Both are electron-updater's defaults; set explicitly so the intended
  // behavior is legible and can't silently change under a dependency bump.
  // autoInstallOnAppQuit means that even if the user picks "Later" below (or is
  // never asked, in --mcp-server mode), the already-downloaded update is
  // applied the next time this process exits normally.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    // Never surface an update failure as a modal: a transient network error,
    // an offline launch, or a build with no matching release must not
    // interrupt the app. Log for diagnosis; the next launch retries. (stderr,
    // not stdout — harmless in GUI mode, but keeps the habit consistent with
    // the rest of this process, which treats stdout as reserved.)
    console.error('[auto-update] update check failed:', err && (err.stack || err.message) ? (err.stack || err.message) : err);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    const version = info && info.version ? info.version : '';

    if (isMcpMode) {
      // Passive by design — see constraints 2 and 3 in the header. The update
      // is already on disk; autoInstallOnAppQuit applies it when Claude
      // Code/Desktop next shuts this server down, so the user lands on the new
      // version at their next session having been interrupted by nothing. No
      // dialog, and above all no quitAndInstall(): killing this process would
      // drop the stdio transport in the middle of whatever the agent is doing.
      console.error(`[auto-update] ${version} downloaded; installs when this MCP server next exits`);
      return;
    }

    // Drive the restart prompt ourselves rather than using
    // checkForUpdatesAndNotify's bare OS notification, so the user gets an
    // explicit choice with context about what changed.
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Timebuddy ${version} is ready to install.`.replace(/\s+/g, ' ').trim(),
      detail: 'Restart to update now, or it will be applied automatically the next time you quit.',
      noLink: true,
    });
    if (response === 0) {
      // (isSilent=false, isForceRunAfter=true): show the platform installer
      // where it has one, and relaunch the app once the update is applied.
      autoUpdater.quitAndInstall(false, true);
    }
  });

  // Fire-and-forget. Two independent promises can reject here, and BOTH must
  // be caught or Electron logs an unhandledRejection (the 'error' listener
  // above is where failures are actually reported — these catches only stop
  // the noise):
  //   1. checkForUpdates() itself, on a failed check.
  //   2. the result's downloadPromise — because autoDownload is true,
  //      checkForUpdates() kicks off a *separate* background download whose
  //      promise nothing else consumes (unlike checkForUpdatesAndNotify). On
  //      macOS with no zip, or any mid-download network failure, it rejects.
  autoUpdater
    .checkForUpdates()
    .then((result) => {
      if (result && result.downloadPromise) result.downloadPromise.catch(() => {});
    })
    .catch(() => {});

  return autoUpdater;
}

module.exports = { setupAutoUpdater };
