const { app, dialog } = require('electron');

// Wires electron-updater into the packaged GUI app. On launch it checks the
// GitHub Releases feed (configured by electron-builder's `build.publish` block
// in package.json, which electron-builder bakes into app-update.yml at pack
// time — there is no feed URL to set here), downloads any newer version in the
// background, and once the download finishes offers the user a restart.
//
// Deliberately a no-op unless the app is BOTH packaged AND running as the GUI
// (never --mcp-server mode), guarded on two independent conditions:
//
//   1. app.isPackaged — an unpackaged dev checkout (`npm start`, the CI
//      integration test) has no app-update.yml, so autoUpdater.checkForUpdates()
//      would immediately error with "config not found". Nothing to update
//      anyway when you're running from source.
//
//   2. !isMcpMode — in --mcp-server mode stdout IS the MCP JSON-RPC channel and
//      this process is owned by Claude Code/Desktop. Popping a restart dialog,
//      relaunching the process out from under its parent, or letting
//      electron-updater write a log line to stdout would all corrupt that
//      session. The updater has no place in that mode.
//
// The caller (main.js) only reaches this in the GUI branch, but we re-check
// both here so the module is safe to call unconditionally and self-documents
// its own preconditions.
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
  if (isMcpMode || !app.isPackaged) return null;

  // Lazy require: keeps electron-updater and its transitive deps out of the
  // process entirely in --mcp-server mode, loaded only once we've decided we
  // actually intend to check for updates.
  const { autoUpdater } = require('electron-updater');

  // Both are electron-updater's defaults; set explicitly so the intended
  // behavior is legible and can't silently change under a dependency bump.
  // autoInstallOnAppQuit means that even if the user picks "Later" below, the
  // already-downloaded update is applied the next time they quit normally.
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
    // Drive the restart prompt ourselves rather than using
    // checkForUpdatesAndNotify's bare OS notification, so the user gets an
    // explicit choice with context about what changed.
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Timebuddy ${info && info.version ? info.version : ''} is ready to install.`.replace(/\s+/g, ' ').trim(),
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
