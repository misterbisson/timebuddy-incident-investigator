const os = require('node:os');
const { app, dialog } = require('electron');
const { claimUpdateCheck } = require('./updateCheckClaim.js');

// Darwin major version of the oldest macOS this build's Electron supports —
// 22 is macOS 13 Ventura, the floor Electron 44 inherited from Chromium.
// Keep in step with scripts/updateFeedMinimumSystemVersion.js, which publishes
// the same floor into the update feed, and with README's requirement line.
const MINIMUM_DARWIN_MAJOR = 22;

// Guards against *the next* floor raise, not the one that shipped with this
// build — worth stating plainly, since the instinct is to expect the opposite.
// The users a floor raise strands are the ones who cannot launch the build that
// contains this function, so it can never run on their machine; the field
// stamped into latest-mac.yml is what protects them (see that script's header).
// What this does cover is the case where a future Electron drops macOS 13 while
// someone is running *this* version: the check below is already installed on
// their machine, so the update is declined locally even if the feed for that
// future release were published without a floor.
//
// Also deliberately ahead of the update-check election in setupAutoUpdater: a
// process that is going to decline every update must not first win the claim
// and burn the interval that an eligible sibling process could have used.
function isOsTooOldForUpdates() {
  if (process.platform !== 'darwin') return false;
  const major = Number.parseInt(os.release().split('.')[0], 10);
  // An unparseable release string is not evidence of an old OS — fail open and
  // let electron-updater's own feed-side check be the authority.
  if (!Number.isFinite(major)) return false;
  return major < MINIMUM_DARWIN_MAJOR;
}

// Read by main.js's idle-shutdown guard (see startMcpServer's
// onIdleShutdown), so the watchdog never quits this process mid-download —
// killing it would drop the partial file and push the next successful
// install out by a full election interval (updateCheckClaim.js), for no
// reason: the ~60s idle recheck costs nothing this process wasn't already
// going to pay. True from the moment electron-updater confirms a newer
// version exists (autoDownload=true means the download starts right after)
// until the download settles one way or another. Stays false forever in
// every process that never runs the updater at all — the unpackaged path,
// or one that lost the update-check election — since nothing here ever sets
// it in that case.
let downloadInProgress = false;

function isUpdateDownloadInProgress() {
  return downloadInProgress;
}

// Named by 'update-available', cleared once the download settles — so a status
// query can say *which* version is being fetched rather than just "something".
let pendingVersion = null;

// Set by 'update-downloaded' and deliberately never cleared: once a build is on
// disk it stays there until this process exits and autoInstallOnAppQuit applies
// it, so a second manual check should report that already-downloaded version
// rather than re-asking the feed and finding the same answer.
let downloadedVersion = null;

// The one wired electron-updater instance. setupAutoUpdater() and
// checkForUpdatesNow() are two entry points onto ONE updater, and wiring the
// listeners twice would mean two restart dialogs for a single download — so both
// go through wireUpdater() and the first caller wins.
let wired = null;

// Dedupes a mashed button: every click made while a check is outstanding gets
// the same promise back instead of starting a second feed request.
let checkInFlight = null;

// Resolvers for manual checks still waiting to hear what the feed said. The
// events below are the only thing that knows — electron-updater reports the
// outcome by event, and its checkForUpdates() promise resolves the same shape
// whether or not there was anything to update.
let pendingChecks = [];

// manualCheckPending is true between a user-initiated check and the event that
// answers it; watchedDownload latches it when that answer turns out to be
// "downloading". Together they are how the download-complete handler knows
// somebody is actually waiting to hear how this ends — which is the one thing
// that makes a dialog in --mcp-server mode appropriate rather than exactly the
// unasked-for interruption constraint 3 below exists to prevent.
let manualCheckPending = false;
let watchedDownload = false;

/**
 * Answers every check waiting on this outcome. Called from the event handlers
 * and, as a backstop, from checkForUpdates()'s own rejection — settling twice is
 * harmless (the queue is emptied first) and never settling would leave a button
 * spinning forever.
 */
function settleChecks(result) {
  const waiting = pendingChecks;
  pendingChecks = [];
  for (const resolve of waiting) resolve(result);
  return result;
}

/**
 * What the UI needs to render the update controls before anything is clicked:
 * the running version, and whether this build can update itself at all. The two
 * unsupported reasons are the same ones setupAutoUpdater() returns null for, and
 * they're reported rather than hidden — a "Check for updates" button that
 * silently does nothing on a dev build or an out-of-support macOS is worse than
 * no button, since the user can't tell "up to date" from "never even asked".
 */
function getUpdateStatus() {
  const reason = !app.isPackaged ? 'dev-build' : isOsTooOldForUpdates() ? 'os-too-old' : null;
  return {
    version: app.getVersion(),
    supported: reason === null,
    reason,
    downloadInProgress,
    downloadedVersion,
  };
}

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
//   4. Process count. There is no requestSingleInstanceLock, so every Claude
//      Code session/worktree spawns its own process — a routine developer
//      machine was observed running 11 at once — and an unconditional check
//      would mean 11 simultaneous ~120MB downloads onto one shared cache path.
//      updateCheckClaim.js elects exactly one of them per interval; the losers
//      return below without even loading electron-updater. main.js's
//      idle-shutdown watchdog (src/idleShutdown.ts, wired up in
//      startMcpServer) is the other half of that same pile-up problem —
//      once a process goes quiet it now quits itself instead of running
//      forever — and isUpdateDownloadInProgress() above is what keeps the
//      two features from fighting: the watchdog defers rather than killing
//      the one process actually mid-download.
//
// GUI launches deliberately skip that election and always check. Opening the app
// is the user's one manual recourse when they want to be current *now*, and
// silently no-opping it because a background MCP process stamped the file an
// hour ago would be a worse bug than the redundant download it saves. The
// tradeoff is a worst case of two concurrent downloads (one GUI, one elected
// MCP) rather than one — bounded, rare, and self-correcting, since
// electron-updater verifies sha512 and simply refuses a corrupted result.
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

  if (isOsTooOldForUpdates()) {
    console.error(
      `[auto-update] skipped: macOS kernel ${os.release()} is older than the minimum ` +
        `Darwin ${MINIMUM_DARWIN_MAJOR} (macOS 13) this build's Electron supports`,
    );
    return null;
  }

  // Elect before doing anything else, so the ~10 processes that lose skip the
  // lazy require entirely rather than each paying for electron-updater and its
  // transitive deps just to sit idle. Returning null here is the same "didn't
  // run" signal as the unpackaged path — nothing downstream distinguishes them.
  if (isMcpMode && !claimUpdateCheck(app.getPath('userData'))) return null;

  return runCheck(wireUpdater({ isMcpMode }));
}

/**
 * Builds the single wired autoUpdater, or returns the one already built.
 *
 * Everything above this point in setupAutoUpdater() is a *policy* guard (is this
 * build updatable, and should this particular process be the one to check);
 * everything below is the wiring itself, which is identical no matter which
 * entry point asked for it. Keeping them apart is what lets
 * checkForUpdatesNow() reuse the policy guards it shares and skip the election
 * it doesn't — a user who clicked a button is not a background process that
 * needs rate-limiting.
 *
 * Callers must apply their own guards first: this function assumes the app is
 * packaged and the OS is supported, and reaching it otherwise would load
 * electron-updater on a path that has already decided not to update.
 */
function wireUpdater({ isMcpMode = false } = {}) {
  if (wired) return wired;

  // Lazy require: keeps electron-updater and its transitive deps out of the
  // process entirely on the paths above, loaded only once we've decided we
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

  // autoDownload=true means the download starts the instant this fires —
  // isUpdateDownloadInProgress() above must read true from here through
  // whichever of 'update-downloaded'/'error' below settles it, with no gap.
  autoUpdater.on('update-available', (info) => {
    downloadInProgress = true;
    pendingVersion = (info && info.version) || null;
    // Latch before settling: the click that started this is answered here, but
    // the person who made it is still owed the *end* of the story below.
    watchedDownload = manualCheckPending;
    manualCheckPending = false;
    settleChecks({ status: 'downloading', version: pendingVersion });
  });
  // No newer version — nothing was ever downloading, but set it anyway
  // rather than assuming: cheap, and correct even if a future
  // electron-updater version ever fires this after 'update-available'.
  autoUpdater.on('update-not-available', () => {
    downloadInProgress = false;
    pendingVersion = null;
    manualCheckPending = false;
    settleChecks({ status: 'up-to-date', version: app.getVersion() });
  });

  autoUpdater.on('error', (err) => {
    downloadInProgress = false;
    pendingVersion = null;
    manualCheckPending = false;
    watchedDownload = false;
    // A manual check is the one caller that DOES hear about a failure. The
    // silence below is right for a background check nobody asked for; it would
    // be a bug for a button, which must never leave the user unable to tell a
    // failed check from a successful one.
    settleChecks({
      status: 'error',
      message: (err && (err.message || String(err))) || 'Update check failed.',
    });
    // Never surface an update failure as a modal: a transient network error,
    // an offline launch, or a build with no matching release must not
    // interrupt the app. Log for diagnosis; the next launch retries. (stderr,
    // not stdout — harmless in GUI mode, but keeps the habit consistent with
    // the rest of this process, which treats stdout as reserved.)
    console.error('[auto-update] update check failed:', err && (err.stack || err.message) ? (err.stack || err.message) : err);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    downloadInProgress = false;
    const version = info && info.version ? info.version : '';
    pendingVersion = null;
    downloadedVersion = version || downloadedVersion;
    manualCheckPending = false;
    // Read once and cleared here: a second download in the same process (there
    // shouldn't be one, but the handler must not assume) is not still owed the
    // answer to a click that was already answered.
    const wasWatched = watchedDownload;
    watchedDownload = false;
    // Only reaches a caller that arrived while the download was already running
    // — the click that started it was settled at 'update-available'. Harmless
    // otherwise: settleChecks on an empty queue does nothing.
    settleChecks({ status: 'downloaded', version });

    if (isMcpMode) {
      // Passive by design — see constraints 2 and 3 in the header. The update
      // is already on disk; autoInstallOnAppQuit applies it when Claude
      // Code/Desktop next shuts this server down, so the user lands on the new
      // version at their next session having been interrupted by nothing. No
      // dialog, and above all no quitAndInstall(): killing this process would
      // drop the stdio transport in the middle of whatever the agent is doing.
      console.error(`[auto-update] ${version} downloaded; installs when this MCP server next exits`);
      // The single exception to constraint 3, and only to constraint 3: a
      // download this user personally asked for, from a window they have open
      // in front of them. What that constraint forbids is an *unasked-for*
      // modal landing on someone mid-session; answering a question they just
      // asked is the opposite of that. Constraint 2 is untouched — this offers
      // no restart and never calls quitAndInstall(), because the reason not to
      // tear down the agent's stdio session doesn't soften just because the
      // user is watching. So the dialog's whole job is to say where the update
      // went, since otherwise a click that worked perfectly looks like nothing
      // happened at all.
      if (wasWatched) {
        await dialog.showMessageBox({
          type: 'info',
          buttons: ['OK'],
          defaultId: 0,
          title: 'Update downloaded',
          message: `Timebuddy ${version} is downloaded.`,
          detail:
            'Claude is running Timebuddy right now, so it will not restart on its own. ' +
            'The update is applied automatically the next time this server exits — when you ' +
            'quit Claude, or once the session has been idle for a while.',
          noLink: true,
        });
      }
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

  wired = autoUpdater;
  return autoUpdater;
}

/**
 * Asks the feed, and returns the same autoUpdater so setupAutoUpdater()'s
 * contract ("the updater, or null if this process isn't checking") is unchanged.
 *
 * Fire-and-forget. Two independent promises can reject here, and BOTH must
 * be caught or Electron logs an unhandledRejection (the 'error' listener
 * above is where failures are actually reported — these catches only stop
 * the noise):
 *   1. checkForUpdates() itself, on a failed check.
 *   2. the result's downloadPromise — because autoDownload is true,
 *      checkForUpdates() kicks off a *separate* background download whose
 *      promise nothing else consumes (unlike checkForUpdatesAndNotify). On
 *      macOS with no zip, or any mid-download network failure, it rejects.
 *
 * The one addition for manual checks: settleChecks() on rejection. Every normal
 * failure also emits 'error', which settles a waiting check already — but "also"
 * is not "always", and a rejection that somehow didn't emit would leave a button
 * spinning with no way back. Settling twice costs nothing; not settling strands
 * the user.
 */
function runCheck(autoUpdater) {
  autoUpdater
    .checkForUpdates()
    .then((result) => {
      if (result && result.downloadPromise) result.downloadPromise.catch(() => {});
    })
    .catch((err) => {
      settleChecks({
        status: 'error',
        message: (err && (err.message || String(err))) || 'Update check failed.',
      });
    });
  return autoUpdater;
}

/**
 * The user asked, explicitly, right now. Returns a promise for what the feed
 * said, in a shape a UI can render:
 *
 *   { status: 'unsupported', reason: 'dev-build' | 'os-too-old', version }
 *   { status: 'up-to-date',  version }            // version = what's running
 *   { status: 'downloading', version }            // version = what's coming
 *   { status: 'downloaded',  version }            // already on disk, awaiting exit
 *   { status: 'error',       message }
 *
 * Three deliberate differences from the automatic path:
 *
 *   1. **No election.** updateCheckClaim.js exists to stop ~11 background MCP
 *      processes each downloading the same 120MB, which is a statement about
 *      *unprompted* checks. A person clicking a button is not that, and
 *      answering "no" because a sibling process stamped a file four hours ago
 *      would be indistinguishable from the button being broken. This is the
 *      same reasoning that already exempts GUI launches (see the header) —
 *      and, like a GUI launch, it doesn't write the stamp either, so it neither
 *      consults nor consumes the background interval.
 *
 *   2. **The unsupported cases are reported, not silent.** setupAutoUpdater()
 *      returns null for a dev build or an out-of-support macOS because there is
 *      nobody to tell; here there is, and "nothing happened" is the one answer
 *      a button must never give.
 *
 *   3. **Deduped.** Rapid clicks share one in-flight check rather than stacking
 *      feed requests and duplicate downloads.
 */
function checkForUpdatesNow({ isMcpMode = false } = {}) {
  const status = getUpdateStatus();
  if (!status.supported) {
    return Promise.resolve({ status: 'unsupported', reason: status.reason, version: status.version });
  }
  // Already on disk from an earlier check in this process: don't re-ask the feed
  // just to be told the same thing, and above all don't restart the download.
  if (downloadedVersion) {
    return Promise.resolve({ status: 'downloaded', version: downloadedVersion });
  }
  if (checkInFlight) return checkInFlight;
  // A download already running (from the launch check) has no check to wait on —
  // 'update-available' fired before this click — so answer from state, and mark
  // the caller as watching so the completion dialog below still reaches them.
  if (downloadInProgress) {
    watchedDownload = true;
    return Promise.resolve({ status: 'downloading', version: pendingVersion });
  }

  const settled = new Promise((resolve) => pendingChecks.push(resolve));
  manualCheckPending = true;
  checkInFlight = settled.finally(() => {
    checkInFlight = null;
  });
  try {
    runCheck(wireUpdater({ isMcpMode }));
  } catch (err) {
    // wireUpdater() throwing means electron-updater itself failed to load —
    // no event will ever arrive, so settle here or the promise never resolves.
    settleChecks({
      status: 'error',
      message: (err && (err.message || String(err))) || 'Update check failed.',
    });
  }
  return checkInFlight;
}

module.exports = {
  setupAutoUpdater,
  checkForUpdatesNow,
  getUpdateStatus,
  isUpdateDownloadInProgress,
  isOsTooOldForUpdates,
};
