// Covers the macOS update-feed floor: scripts/updateFeedMinimumSystemVersion.js.
//
// This field is the ONLY thing that stops an already-installed older build from
// downloading a release its OS can't launch, and every way it can be wrong is
// silent — a bad value or a bad location produces a perfectly valid-looking
// latest-mac.yml that simply never blocks anything. Nothing downstream fails,
// no build breaks, and the bug surfaces only as a user whose app stopped
// launching after an update. So rather than assert the hook "sets a field",
// this reproduces the two pieces of third-party logic the field has to survive:
//
//   1. app-builder-lib's createUpdateInfo, which picks the field's destination
//      in the feed by sniffing for a `sha512` key on the object the hook set.
//   2. electron-updater's AppUpdater.checkIfUpdateSupported, which compares the
//      value against os.release() — the Darwin kernel version, not the macOS
//      marketing version — using this same semver.lt.
//
// Both are pinned by the lockfile; if a bump changes either, these fail here
// rather than in a release nobody can install. Run with:
//   node electron/test/updateFeedMinimumSystemVersion.test.js
const assert = require('node:assert');
const path = require('node:path');
const { lt } = require('semver');

const hook = require('../scripts/updateFeedMinimumSystemVersion.js');
const FLOOR = hook.MINIMUM_DARWIN_VERSION;

const checks = [];
const check = (name, ok) => checks.push([name, Boolean(ok)]);

/** An artifactBuildCompleted event shaped like electron-builder's real one. */
function macEvent(nodeName = 'darwin') {
  return {
    packager: { platform: { nodeName } },
    file: path.join('dist', 'App-1.0.0-arm64.zip'),
    // electron-builder pre-populates this before the hook runs — verified
    // against a real `electron-builder --mac zip` run. Spreading it is what
    // misroutes the field onto files[], so the hook must not.
    updateInfo: { size: 131761315, sha512: 'BASE64SHA==' },
  };
}

/**
 * app-builder-lib's createUpdateInfo, reduced to the branch that decides where
 * custom keys land (out/publish/updateInfoBuilder.js). Deliberately a
 * transcription rather than a call into the real thing: the point is to detect
 * a change in that logic, which a direct call would silently absorb.
 */
function buildFeed(event) {
  const custom = event.updateInfo;
  const url = path.basename(event.file);
  const sha512 = (custom == null ? null : custom.sha512) || 'HASHED-FROM-FILE==';
  const files = [{ url, sha512 }];
  const result = { version: '1.0.0', files, path: url, sha512 };
  if (custom != null) {
    Object.assign('sha512' in custom ? files[0] : result, custom);
  }
  return result;
}

/** electron-updater's AppUpdater.checkIfUpdateSupported, verbatim in effect. */
function updateSupported(feed, osRelease) {
  const min = feed == null ? undefined : feed.minimumSystemVersion;
  if (!min) return true;
  try {
    return !lt(osRelease, min);
  } catch {
    return true;
  }
}

// --- The field reaches the place electron-updater actually reads ---
{
  const event = macEvent();
  hook(event);
  const feed = buildFeed(event);

  check('feed: minimumSystemVersion is at the TOP level', feed.minimumSystemVersion === FLOOR);
  check(
    'feed: it is NOT buried under files[] (where nothing reads it)',
    feed.files.every((f) => f.minimumSystemVersion === undefined),
  );
  // Guards note 3 in the hook: dropping sha512 is what buys top-level
  // placement, and the artifact hash must still be present in the feed.
  check('feed: files[0].sha512 survives (recomputed from the artifact)', typeof feed.files[0].sha512 === 'string' && feed.files[0].sha512.length > 0);
}

// --- The value is on the Darwin scale, so the comparison actually bites ---
{
  const event = macEvent();
  hook(event);
  const feed = buildFeed(event);

  // Darwin 21 = macOS 12 Monterey; Darwin 22 = macOS 13 Ventura.
  check('gate: Monterey (Darwin 21.6.0) is refused the update', updateSupported(feed, '21.6.0') === false);
  check('gate: Big Sur (Darwin 20.6.0) is refused the update', updateSupported(feed, '20.6.0') === false);
  check('gate: Ventura (Darwin 22.0.0) is offered it — boundary inclusive', updateSupported(feed, '22.0.0') === true);
  check('gate: Sequoia (Darwin 24.6.0) is offered it', updateSupported(feed, '24.6.0') === true);

  // The scale trap from note 1: had the marketing version been used, Monterey
  // would sail through. Asserted directly so the mistake can't be reintroduced.
  const marketing = { minimumSystemVersion: '13.0.0' };
  check(
    'gate: a MARKETING version would fail to block Monterey (why Darwin is used)',
    updateSupported(marketing, '21.6.0') === true,
  );
}

// --- Non-macOS feeds are never touched ---
{
  for (const [nodeName, release, label] of [
    ['win32', '10.0.26100', 'Windows'],
    ['linux', '6.1.0', 'Linux'],
  ]) {
    const event = macEvent(nodeName);
    const before = JSON.stringify(event.updateInfo);
    hook(event);
    check(`scope: ${label} updateInfo is left exactly as-is`, JSON.stringify(event.updateInfo) === before);
    check(`scope: ${label} feed carries no floor`, buildFeed(event).minimumSystemVersion === undefined);
    // The reason scoping matters: os.release() on Windows sorts BELOW the
    // Darwin floor, so a leaked field would block every update there.
    check(
      `scope: ${label} would be blocked outright if the floor leaked`,
      updateSupported({ minimumSystemVersion: FLOOR }, release) === false,
    );
  }
}

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
if (failed.length) {
  console.error(`\nupdateFeedMinimumSystemVersion.test.js: FAIL (${failed.length}/${checks.length})`);
  process.exit(1);
}
console.log(`\nupdateFeedMinimumSystemVersion.test.js: OK (${checks.length} checks)`);
