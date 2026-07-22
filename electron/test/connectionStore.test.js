// Exercises connectionStore.js directly (bypassing the renderer/IPC layer),
// covering the Grafana/Graylog `kind` split added for the connection-manager
// UI: both kinds round-trip through listConnectionsForDisplay(), each
// engine-facing getter only returns its own kind, secrets decrypt correctly
// per kind's authType, and editing with a blank secret field keeps the
// previously stored one. Run with:
//   electron test/connectionStore.test.js --user-data-dir=<dir>
const assert = require('node:assert');
const { app } = require('electron');

// Must match main.js's app.setName() call — safeStorage's encryption key is
// scoped to the app identity, so a mismatch here would produce a secret this
// same process can't decrypt back.
app.setName('timebuddy-connection-manager');

app.whenReady().then(() => {
  try {
    const store = require('../src/connectionStore.js');

    const grafana = store.upsertConnection({
      name: 'grafana-prod',
      kind: 'grafana',
      url: 'https://grafana.example.com',
      authType: 'bearer',
      token: 'grafana-token-1',
      matchHosts: ['grafana-lb.internal'],
      tags: ['prod', 'us-east'],
    });

    const graylog = store.upsertConnection({
      name: 'graylog-prod',
      kind: 'graylog',
      url: 'https://graylog.example.com',
      authType: 'token',
      token: 'graylog-token-1',
      streamId: 'stream-123',
      streamName: 'APIGW 5xx',
      tags: ['prod', 'us-east'],
    });

    const displayed = store.listConnectionsForDisplay();
    assert.strictEqual(displayed.length, 2, 'expected both connections in the display list');
    const displayedGrafana = displayed.find((c) => c.id === grafana.id);
    const displayedGraylog = displayed.find((c) => c.id === graylog.id);
    assert.strictEqual(displayedGrafana.kind, 'grafana');
    assert.strictEqual(displayedGraylog.kind, 'graylog');
    assert.strictEqual(displayedGrafana.hasSecret, true);
    assert.strictEqual(displayedGraylog.hasSecret, true);
    assert.strictEqual(displayedGrafana.token, undefined, 'display list must never include a secret');
    assert.strictEqual(displayedGraylog.token, undefined, 'display list must never include a secret');

    const grafanaConnections = store.getConnectionsForEngine();
    assert.strictEqual(grafanaConnections.length, 1, 'getConnectionsForEngine must exclude graylog connections');
    assert.strictEqual(grafanaConnections[0].id, grafana.id);
    assert.strictEqual(grafanaConnections[0].token, 'grafana-token-1');
    assert.deepStrictEqual(grafanaConnections[0].matchHosts, ['grafana-lb.internal']);
    assert.deepStrictEqual(grafanaConnections[0].tags, ['prod', 'us-east']);

    const logConnections = store.getLogConnectionsForEngine();
    assert.strictEqual(logConnections.length, 1, 'getLogConnectionsForEngine must exclude grafana connections');
    assert.strictEqual(logConnections[0].id, graylog.id);
    assert.strictEqual(logConnections[0].sourceType, 'graylog');
    assert.strictEqual(logConnections[0].token, 'graylog-token-1');
    assert.strictEqual(logConnections[0].streamId, 'stream-123');
    assert.strictEqual(logConnections[0].streamName, 'APIGW 5xx');
    assert.deepStrictEqual(logConnections[0].tags, ['prod', 'us-east']);

    // Editing with a blank token keeps the previously stored secret (same
    // behavior as Grafana connections, see connectionStore.js's upsertConnection doc comment).
    store.upsertConnection({
      id: graylog.id,
      kind: 'graylog',
      name: 'graylog-prod-renamed',
      url: 'https://graylog.example.com',
      authType: 'token',
      token: '',
      streamId: 'stream-123',
      tags: ['prod', 'us-east'],
    });
    const afterEdit = store.getLogConnectionsForEngine();
    assert.strictEqual(afterEdit[0].token, 'graylog-token-1', 'blank token on edit must keep the existing secret');
    assert.strictEqual(afterEdit[0].name, 'graylog-prod-renamed');

    store.deleteConnection(grafana.id);
    store.deleteConnection(graylog.id);
    assert.strictEqual(store.listConnectionsForDisplay().length, 0, 'expected both connections deleted');

    console.log('ALL CHECKS PASSED');
    app.exit(0);
  } catch (err) {
    console.error('FAIL:', err instanceof Error ? err.stack : String(err));
    app.exit(1);
  }
});
