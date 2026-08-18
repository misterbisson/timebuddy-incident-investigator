const fs = require('node:fs');
const path = require('node:path');

// Elects exactly one process to perform an update check.
//
// This exists because --mcp-server has no single-instance lock: Claude
// Code/Desktop spawns one process per session/worktree, and a routine developer
// machine was observed running 11 at once. Without election, enabling the
// updater there means 11 simultaneous checks and up to 11 simultaneous ~120MB
// downloads, all writing the same `update.zip` in one shared cache directory.
//
// Deliberately NOT app.requestSingleInstanceLock(): that makes the second
// instance quit, which would break the multi-session MCP model outright. What's
// wanted is "one of you checks", not "only one of you exists".
//
// Two files, doing two different jobs:
//
//   last-update-check       a timestamp. Its mtime is the real gate — if it's
//                           newer than intervalMs, somebody checked recently
//                           and everyone else stands down. This is what
//                           prevents concurrent downloads across staggered
//                           process starts, which is the common case.
//
//   last-update-check.lock  created with the 'wx' flag, which is atomic on both
//                           POSIX and Windows (O_EXCL / CREATE_NEW). This only
//                           covers the read-then-write window, for the rarer
//                           case of processes starting close enough together
//                           that they all stat the stamp before any of them
//                           writes it. Held for microseconds, never across the
//                           download itself.
//
// Every failure path returns false — declining to check is always safe (the
// next process, or the next session, tries again), whereas throwing here would
// propagate into MCP server startup and cost the user their tools over a
// missed update check.
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// A claim is released within microseconds, so a lock older than this belongs to
// a process that died between creating it and releasing it. Generous by orders
// of magnitude on purpose: reclaiming too eagerly reintroduces the double-check
// this is here to prevent, while reclaiming late merely delays one check.
const LOCK_STALE_MS = 60 * 1000;

/**
 * @param {string} dir            directory to keep the stamp/lock in (userData)
 * @param {object} [opts]
 * @param {number} [opts.intervalMs]  minimum gap between checks
 * @param {number} [opts.now]         injectable clock, for tests
 * @returns {boolean} true if THIS process should perform the check
 */
function claimUpdateCheck(dir, { intervalMs = DEFAULT_INTERVAL_MS, now = Date.now() } = {}) {
  const stampPath = path.join(dir, 'last-update-check');
  const lockPath = `${stampPath}.lock`;

  try {
    if (now - fs.statSync(stampPath).mtimeMs < intervalMs) return false;
  } catch {
    // No stamp: first run on this machine (or userData was cleared). Fall
    // through and try to claim.
  }

  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch {
    // Either a sibling holds the claim right now, or a previous holder died
    // before releasing it. Distinguish by age rather than assuming either way.
    try {
      if (now - fs.statSync(lockPath).mtimeMs < LOCK_STALE_MS) return false;
      fs.unlinkSync(lockPath);
      fd = fs.openSync(lockPath, 'wx');
    } catch {
      return false; // lost the reclaim race too — a sibling is checking
    }
  }

  try {
    // Stamp BEFORE the check runs, not after it succeeds. A check that hangs,
    // errors, or takes the whole download to finish must still push the next
    // attempt out by intervalMs; stamping afterwards would let every sibling
    // that starts in the meantime claim as well, restoring the fan-out.
    fs.writeFileSync(stampPath, `${new Date(now).toISOString()}\n`);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}

module.exports = { claimUpdateCheck, DEFAULT_INTERVAL_MS, LOCK_STALE_MS };
