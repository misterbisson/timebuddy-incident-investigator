// Seeds a Grafana and a Graylog connection directly through
// connectionStore.js (bypassing the renderer/IPC layer) so integration tests
// can run headlessly. Run with:
//   electron test/seedConnection.js --user-data-dir=<dir>
const { app, safeStorage } = require('electron');

// Belt-and-suspenders alongside the --password-store=basic CLI switch: a CI
// run with that switch passed on the command line still saw
// isEncryptionAvailable() return false, so this calls the same Electron API
// its own docs recommend, in case the raw CLI switch isn't taking effect for
// some reason this environment-specific.
app.commandLine.appendSwitch('password-store', 'basic');

// Must match main.js's app.setName() call — safeStorage's encryption key is
// scoped to the app identity, so seeding under a different name here would
// produce a secret main.js's --mcp-server mode can't decrypt.
app.setName('timebuddy-connection-manager');

console.log('[seed] requiring electron done, waiting for whenReady()');
console.log('[seed] argv:', process.argv);
console.log('[seed] XDG_CURRENT_DESKTOP=%s DESKTOP_SESSION=%s DISPLAY=%s', process.env.XDG_CURRENT_DESKTOP, process.env.DESKTOP_SESSION, process.env.DISPLAY);

app.whenReady().then(() => {
  console.log('[seed] whenReady() resolved');
  // The missing piece, Linux-only (these methods don't exist at all on
  // macOS/Windows): selecting the basic_text backend (--password-store=
  // basic) alone does NOT make isEncryptionAvailable() true. Electron's
  // native IsEncryptionAvailable() on Linux is:
  //   OSCrypt::IsEncryptionAvailable() || (use_password_v10_ && backend == "basic_text")
  // — that use_password_v10_ flag is a separate opt-in, set via this call
  // (added in Electron 25.5.0), acknowledging the weaker guarantee.
  if (process.platform === 'linux') {
    safeStorage.setUsePlainTextEncryption(true);
    console.log('[seed] safeStorage.getSelectedStorageBackend() =', safeStorage.getSelectedStorageBackend());
  }
  console.log('[seed] safeStorage.isEncryptionAvailable() =', safeStorage.isEncryptionAvailable());
  const store = require('../src/connectionStore.js');
  console.log('[seed] connectionStore required, upserting grafana connection');
  store.upsertConnection({
    name: 'test-connection',
    kind: 'grafana',
    url: 'https://grafana.example.com',
    authType: 'bearer',
    token: 'test-token-12345',
  });
  console.log('[seed] grafana connection upserted, upserting graylog connection');
  store.upsertConnection({
    name: 'test-log-connection',
    kind: 'graylog',
    url: 'https://graylog.example.com',
    authType: 'token',
    token: 'test-graylog-token-12345',
  });
  console.log('[seed] graylog connection upserted, exiting');
  app.exit(0);
}).catch((err) => {
  // Without this, a throw in the block above is an unhandled rejection that
  // Electron logs a warning for but does NOT exit on — the process (and any
  // parent spawnSync waiting on it) then hangs indefinitely instead of
  // failing fast.
  console.error('[seed] FAILED:', err);
  app.exit(1);
});
