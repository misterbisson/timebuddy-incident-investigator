// Stamps `minimumSystemVersion` into the macOS update feed (latest-mac.yml).
//
// This is the only thing that stops an *already-installed* older build from
// downloading a release its OS can't launch, and the direction of that is worth
// being explicit about, because it's the opposite of where you'd look for it:
// the comparison runs inside the OLD app's bundled electron-updater
// (AppUpdater.checkIfUpdateSupported → isUpdateAvailable, which emits
// `update-not-available` and downloads nothing), reading this field out of the
// NEW release's feed. The protection is therefore delivered entirely by what we
// publish. A gate compiled into the new version — src/updater.js's
// isOsTooOldForUpdates() — cannot help with the raise that shipped it, because
// the users it would protect are precisely the ones who can't run that build;
// that gate is for the *next* raise.
//
// Four things here are load-bearing, and all four fail silently rather than
// loudly, which is why each is spelled out:
//
//   1. **The value is a Darwin version, not a marketing version.**
//      electron-updater compares against `os.release()`, which on macOS is the
//      kernel version (Monterey 21.x, Ventura 22.x, Sonoma 23.x, Sequoia 24.x)
//      — not "13.0.0". The marketing version would make the check
//      `semver.lt("21.6.0", "13.0.0")` → false, i.e. it would hand Monterey the
//      very update it was meant to withhold. Note this is a DIFFERENT field
//      from `build.mac.minimumSystemVersion` in package.json, which
//      app-builder-lib writes to Info.plist's LSMinimumSystemVersion and which
//      *is* the marketing version. Same name, two scales.
//
//   2. **The field must land at the TOP level of the feed, not on files[].**
//      builder-util-runtime declares minimumSystemVersion on `UpdateInfo`, not
//      on `UpdateFileInfo`, and checkIfUpdateSupported reads
//      `updateInfo.minimumSystemVersion`. app-builder-lib's createUpdateInfo
//      chooses the destination by sniffing this object:
//        Object.assign("sha512" in customUpdateInfo ? files[0] : result, …)
//      electron-builder pre-populates event.updateInfo with `{size, sha512}`,
//      so spreading it — the obvious implementation — routes these keys onto
//      files[0], where nothing ever reads them. Hence the deliberately fresh
//      object below with no sha512 key. A build whose latest-mac.yml shows
//      minimumSystemVersion indented under `files:` is this bug, not a variant.
//
//   3. **Dropping sha512 also drops files[0].size, and that is fine.**
//      createUpdateInfo recomputes sha512 from the artifact when we don't supply
//      it (same value), but `size` is only carried by the object we replace.
//      Its sole consumer is MacUpdater.updateDownloaded, which reads
//      `zipFileInfo.info.size ?? (await stat(downloadedFile)).size` — an
//      explicit fallback to stat'ing the file it just downloaded. Differential
//      downloads key off the .blockmap, not this field.
//
//   4. **It must be scoped to macOS artifacts.** artifactBuildCompleted fires
//      for every artifact on every platform, and the Windows/Linux feeds share
//      the field name. `os.release()` on Windows looks like "10.0.26100", so an
//      unscoped Darwin floor evaluates `semver.lt("10.0.26100", "22.0.0")` →
//      true and would silently block *every* Windows update.
//
// Declaring this in package.json as `build.mac.releaseInfo.minimumSystemVersion`
// would be tidier — getReleaseInfo() spreads releaseInfo straight into the
// top-level result and is already platform-scoped — but electron-builder's
// schema validator rejects keys it doesn't know inside releaseInfo, so the
// build fails outright. Hence a hook.

// macOS 13 Ventura. Raise in lockstep with Electron's supported-OS floor
// (Electron 44 dropped macOS 12), together with MINIMUM_DARWIN_MAJOR in
// src/updater.js, `build.mac.minimumSystemVersion` in package.json, and the
// requirement line in README.md.
const MINIMUM_DARWIN_VERSION = '22.0.0';

const artifactBuildCompleted = event => {
  const platform = event && event.packager && event.packager.platform;
  if (!platform || platform.nodeName !== 'darwin') return;

  // A fresh object, NOT a spread of event.updateInfo — see note 2 above. The
  // absence of a `sha512` key is what puts this at the top level of the feed.
  event.updateInfo = { minimumSystemVersion: MINIMUM_DARWIN_VERSION };
};

module.exports = artifactBuildCompleted;
module.exports.default = artifactBuildCompleted;
module.exports.MINIMUM_DARWIN_VERSION = MINIMUM_DARWIN_VERSION;
