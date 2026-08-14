// Covers what updater.test.js structurally cannot: the behavior of
// setupAutoUpdater PAST the app.isPackaged guard. That sibling runs under a real
// `electron test/...` invocation, where app.isPackaged is always false, so every
// call short-circuits and the interesting branches are unreachable.
//
// This file stubs `electron` and `electron-updater` at the module-resolution
// layer instead, which buys two things: the packaged path becomes reachable, and
// the test needs neither the ~100MB Electron binary nor a display server — so it
// runs in the fast `test` CI job alongside the engine's vitest suite rather than
// in the heavyweight electron-mcp-server job. Run with:
//   node electron/test/updaterBehavior.test.js
//
// The property that matters most here is the stdout one. In --mcp-server mode
// stdout is the MCP JSON-RPC channel, and a stray updater log line corrupts the
// session silently rather than failing loudly — there is no error to notice, the
// agent's transport just starts misparsing. That failure is invisible in manual
// testing, which is exactly why it's asserted mechanically.
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UPDATER = path.join(__dirname, '..', 'src', 'updater.js');
const CLAIM = path.join(__dirname, '..', 'src', 'updateCheckClaim.js');

let dialogCalls;
let quitAndInstallCalls;
let autoUpdater;
let dialogResponse;
let isPackaged;
let userDataDir;

const realLoad = Module._load;

/** A scratch userData for the election's stamp/lock files. */
function freshUserData(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tb-updater-${label}-`));
}

/** Fresh stubs + a fresh module registry entry, so each case starts clean. */
function loadUpdater({ packaged = true, response = 0, dataDir = null } = {}) {
  dialogCalls = [];
  quitAndInstallCalls = [];
  dialogResponse = response;
  isPackaged = packaged;
  userDataDir = dataDir || freshUserData('case');

  autoUpdater = new EventEmitter();
  autoUpdater.autoDownload = null;
  autoUpdater.autoInstallOnAppQuit = null;
  autoUpdater.logger = 'UNSET';
  autoUpdater.quitAndInstall = (...args) => quitAndInstallCalls.push(args);
  // Resolved rather than pending: setupAutoUpdater consumes both this and the
  // downloadPromise, and an unhandled rejection here would fail the run.
  autoUpdater.checkForUpdates = () => Promise.resolve({ downloadPromise: Promise.resolve() });

  Module._load = function (request) {
    if (request === 'electron') {
      return {
        app: { isPackaged, getPath: () => userDataDir },
        dialog: {
          showMessageBox: async (opts) => {
            dialogCalls.push(opts);
            return { response: dialogResponse };
          },
        },
      };
    }
    if (request === 'electron-updater') {
      if (!isPackaged) throw new Error('electron-updater must not be required on the unpackaged path');
      return { autoUpdater };
    }
    return realLoad.apply(this, arguments);
  };

  delete require.cache[UPDATER];
  return require(UPDATER).setupAutoUpdater;
}

/** Runs fn with stdout/stderr captured, returning everything written to each. */
async function captureOutput(fn) {
  const out = [];
  const err = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  try {
    await fn();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { stdout: out.join(''), stderr: err.join('') };
}

const checks = [];
const check = (name, ok) => checks.push([name, Boolean(ok)]);
/** Lets the 'update-downloaded' async handler and its awaited dialog settle. */
const settle = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

(async () => {
  // --- --mcp-server mode: download, but never interrupt the session ---
  {
    const setupAutoUpdater = loadUpdater({ packaged: true });
    let updater;
    const { stdout, stderr } = await captureOutput(async () => {
      updater = setupAutoUpdater({ isMcpMode: true });
      // Drive the logger the way electron-updater itself would.
      updater.logger.info('checking for update');
      updater.logger.debug('progress chunk 1/1000');
      updater.emit('update-downloaded', { version: '0.7.2' });
      await settle();
    });

    check('mcp: sets up rather than refusing outright', updater !== null);
    check('mcp: no restart dialog', dialogCalls.length === 0);
    check('mcp: quitAndInstall is NEVER called', quitAndInstallCalls.length === 0);
    check('mcp: autoInstallOnAppQuit left on, so the exit applies it', updater.autoInstallOnAppQuit === true);
    check('mcp: autoDownload left on', updater.autoDownload === true);
    check('mcp: the downloaded version is announced on stderr', stderr.includes('0.7.2'));
    check('mcp: NOTHING reaches stdout (the JSON-RPC channel)', stdout === '');
  }

  // --- The logger is pinned, not left on electron-updater's console default ---
  {
    const setupAutoUpdater = loadUpdater({ packaged: true });
    let updater;
    const { stdout, stderr } = await captureOutput(async () => {
      updater = setupAutoUpdater({ isMcpMode: false });
      updater.logger.info('info line');
      updater.logger.warn('warn line');
      updater.logger.error('error line');
      updater.logger.debug('debug line');
    });

    check('logger: replaced with our own shim', typeof updater.logger === 'object' && updater.logger !== null);
    check('logger: info goes to stderr', stderr.includes('info line'));
    check('logger: warn goes to stderr', stderr.includes('warn line'));
    check('logger: error goes to stderr', stderr.includes('error line'));
    check('logger: debug is dropped, not merely redirected', !stderr.includes('debug line'));
    check('logger: no level writes to stdout', stdout === '');
  }

  // --- GUI mode keeps the interactive path intact ---
  {
    const setupAutoUpdater = loadUpdater({ packaged: true, response: 0 });
    const updater = setupAutoUpdater({ isMcpMode: false });
    updater.emit('update-downloaded', { version: '0.7.2' });
    await settle();

    check('gui: restart dialog is shown', dialogCalls.length === 1);
    check('gui: dialog names the version', (dialogCalls[0] || {}).message === 'Timebuddy 0.7.2 is ready to install.');
    check('gui: "Restart now" installs', quitAndInstallCalls.length === 1);
    check('gui: quitAndInstall(isSilent=false, isForceRunAfter=true)', JSON.stringify(quitAndInstallCalls[0]) === '[false,true]');
  }

  // --- "Later" defers to autoInstallOnAppQuit rather than installing now ---
  {
    const setupAutoUpdater = loadUpdater({ packaged: true, response: 1 });
    const updater = setupAutoUpdater({ isMcpMode: false });
    updater.emit('update-downloaded', { version: '0.7.2' });
    await settle();

    check('gui/Later: dialog shown', dialogCalls.length === 1);
    check('gui/Later: quitAndInstall NOT called', quitAndInstallCalls.length === 0);
  }

  // --- Unpackaged still no-ops in every mode (updater.test.js's property,
  //     re-asserted here so it survives a refactor of the guard) ---
  {
    const setupAutoUpdater = loadUpdater({ packaged: false });
    let ok = false;
    try {
      ok =
        setupAutoUpdater({ isMcpMode: false }) === null &&
        setupAutoUpdater({ isMcpMode: true }) === null &&
        setupAutoUpdater() === null;
    } catch {
      ok = false; // a throw means the lazy require ran — the guard leaked
    }
    check('unpackaged: no-ops in every mode without loading electron-updater', ok);
  }

  Module._load = realLoad;

  // --- The election itself (updateCheckClaim.js — no electron dependency) ---
  const { claimUpdateCheck, LOCK_STALE_MS } = require(CLAIM);
  {
    const dir = freshUserData('claim');
    const t0 = 1_700_000_000_000;
    const interval = 6 * 60 * 60 * 1000;

    check('claim: first run on a fresh userData wins', claimUpdateCheck(dir, { intervalMs: interval, now: t0 }) === true);
    check('claim: an immediate second attempt stands down', claimUpdateCheck(dir, { intervalMs: interval, now: t0 }) === false);
    check(
      'claim: still standing down just before the interval elapses',
      claimUpdateCheck(dir, { intervalMs: interval, now: t0 + interval - 1000 }) === false,
    );
    // mtime is the gate, and the file was really written, so advance the clock
    // past the interval measured from *now* rather than from the injected t0.
    check(
      'claim: wins again once the interval has elapsed',
      claimUpdateCheck(dir, { intervalMs: 1, now: Date.now() + 1000 }) === true,
    );
  }

  {
    // A live sibling holding the claim blocks. Kept in its own scratch dir from
    // the stale-lock case below: sharing one directory means a regression here
    // corrupts the setup there and aborts the run instead of reporting.
    const dir = freshUserData('lock');
    const lockPath = path.join(dir, 'last-update-check.lock');
    fs.writeFileSync(lockPath, '');

    check('claim: a fresh sibling lock blocks', claimUpdateCheck(dir, { intervalMs: 1, now: Date.now() }) === false);
    // Directly pins the atomic-claim behavior: standing down must not disturb
    // the holder's lock. Without the 'wx' claim this is what breaks first.
    check('claim: standing down leaves the sibling lock intact', fs.existsSync(lockPath));
  }

  {
    // A lock left behind by a process that died mid-claim must not block forever.
    const dir = freshUserData('stale');
    const lockPath = path.join(dir, 'last-update-check.lock');
    fs.writeFileSync(lockPath, '');
    const stale = Date.now() - (LOCK_STALE_MS + 60_000);
    fs.utimesSync(lockPath, new Date(stale), new Date(stale));

    check('claim: a stale lock is reclaimed rather than deadlocking', claimUpdateCheck(dir, { intervalMs: 1, now: Date.now() }) === true);
    check('claim: the lock is released, not leaked', !fs.existsSync(lockPath));
  }

  {
    // The real thing this design exists for: N processes starting at once must
    // produce exactly one checker. Genuine concurrent processes, not a
    // simulation — the race is between separate OS processes touching one
    // directory, which is precisely what a single-threaded stub cannot model.
    const dir = freshUserData('race');
    const N = 12;
    const script = `const {claimUpdateCheck}=require(${JSON.stringify(CLAIM)});process.stdout.write(claimUpdateCheck(${JSON.stringify(dir)})?'WIN':'skip')`;

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.on('close', () => resolve(out));
        }),
      ),
    );

    const winners = results.filter((r) => r === 'WIN').length;
    check(`race: exactly 1 of ${N} concurrent processes checks (got ${winners})`, winners === 1);
    check('race: every other process stood down cleanly', results.filter((r) => r === 'skip').length === N - 1);
  }

  // --- End to end through setupAutoUpdater: elected once, skipped after ---
  {
    const shared = freshUserData('shared');

    let setupAutoUpdater = loadUpdater({ packaged: true, dataDir: shared });
    const first = setupAutoUpdater({ isMcpMode: true });
    check('mcp: the elected process sets the updater up', first !== null);

    setupAutoUpdater = loadUpdater({ packaged: true, dataDir: shared });
    const second = setupAutoUpdater({ isMcpMode: true });
    check('mcp: a sibling in the same interval no-ops', second === null);

    // Losing the election must be as cheap as being unpackaged — that's the
    // whole reason the claim is checked before the lazy require.
    check(
      'mcp: a stood-down process never loads electron-updater',
      !Object.keys(require.cache).some((p) => p.includes(`${path.sep}electron-updater${path.sep}`)),
    );

    // A GUI launch is the user's manual recourse and must not be swallowed by a
    // stamp an MCP process wrote moments ago.
    setupAutoUpdater = loadUpdater({ packaged: true, dataDir: shared });
    check('gui: always checks, ignoring the election stamp', setupAutoUpdater({ isMcpMode: false }) !== null);
  }

  Module._load = realLoad;

  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (failed.length) {
    console.error(`\nupdaterBehavior.test.js: FAIL (${failed.length}/${checks.length})`);
    process.exit(1);
  }
  console.log(`\nupdaterBehavior.test.js: OK (${checks.length} checks)`);
})().catch((err) => {
  Module._load = realLoad;
  console.error('updaterBehavior.test.js: FAIL');
  console.error(err);
  process.exit(1);
});
