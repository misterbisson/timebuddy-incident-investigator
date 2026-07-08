// Seeds one connection directly through connectionStore.js (bypassing the
// renderer/IPC layer) so integration tests can run headlessly. Run with:
//   electron test/seedConnection.js --user-data-dir=<dir>
const { app } = require('electron');

// Must match main.js's app.setName() call — safeStorage's encryption key is
// scoped to the app identity, so seeding under a different name here would
// produce a secret main.js's --mcp-server mode can't decrypt.
app.setName('timebuddy-connection-manager');

app.whenReady().then(() => {
  const store = require('../src/connectionStore.js');
  store.upsertConnection({
    kind: 'grafana',
    name: 'test-connection',
    url: 'https://grafana.example.com',
    authType: 'bearer',
    token: 'test-token-12345',
  });
  store.upsertConnection({
    kind: 'graylog',
    name: 'test-log-connection',
    url: 'https://graylog.example.com',
    authType: 'bearer',
    token: 'test-log-token-12345',
  });
  app.exit(0);
});
