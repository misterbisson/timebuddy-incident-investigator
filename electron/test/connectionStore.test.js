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

    // --- importConnections: metadata-only manifest + shared credential ---
    const importSummary = store.importConnections(
      {
        version: 1,
        connections: [
          { kind: 'grafana', name: 'imp-bearer', url: 'https://imp-g1.example.com', authType: 'bearer', tags: ['imp'] },
          { kind: 'grafana', name: 'imp-basic', url: 'https://imp-g2.example.com', authType: 'basic' },
          { kind: 'graylog', name: 'imp-logs', url: 'https://imp-gl.example.com', authType: 'basic', streamName: 'S' },
        ],
      },
      { username: 'shared-user', password: 'shared-pass' },
    );
    assert.strictEqual(importSummary.total, 3, 'expected 3 imported');
    assert.strictEqual(importSummary.created, 3, 'all three are new');
    assert.strictEqual(importSummary.updated, 0);
    // The shared login lands on both basic-auth connections; the bearer one has no secret.
    assert.strictEqual(importSummary.configured, 2, 'both basic-auth connections got the shared credential');
    assert.deepStrictEqual(
      importSummary.needSecret.map((c) => c.name),
      ['imp-bearer'],
      'the bearer connection still needs a token',
    );

    const imported = store.listConnectionsForDisplay();
    assert.strictEqual(imported.length, 3, 'expected 3 connections after import');
    const impBasic = imported.find((c) => c.name === 'imp-basic');
    assert.strictEqual(impBasic.hasSecret, true);
    assert.strictEqual(impBasic.username, 'shared-user', 'shared username stored as metadata');

    // The shared credential really decrypts through the engine path.
    const impGrafanaEngine = store.getConnectionsForEngine().find((c) => c.url === 'https://imp-g2.example.com');
    assert.strictEqual(impGrafanaEngine.username, 'shared-user');
    assert.strictEqual(impGrafanaEngine.password, 'shared-pass');

    // Re-import (idempotent on url+kind): a rename with no shared password
    // updates metadata in place and keeps the existing secret, no duplicate row.
    const reSummary = store.importConnections({
      connections: [
        { kind: 'grafana', name: 'imp-basic-renamed', url: 'https://imp-g2.example.com/', authType: 'basic' },
      ],
    });
    assert.strictEqual(reSummary.updated, 1, 'matched existing on url+kind');
    assert.strictEqual(reSummary.created, 0, 'no duplicate created despite trailing slash');
    assert.strictEqual(reSummary.configured, 1, 'existing secret preserved on re-import');
    const afterReimport = store.listConnectionsForDisplay();
    assert.strictEqual(afterReimport.length, 3, 'still 3 connections, not 4');
    const renamed = afterReimport.find((c) => c.url === 'https://imp-g2.example.com');
    assert.strictEqual(renamed.name, 'imp-basic-renamed', 'metadata updated in place');
    assert.strictEqual(renamed.username, 'shared-user', 'username preserved when manifest omits it');
    assert.strictEqual(
      store.getConnectionsForEngine().find((c) => c.url === 'https://imp-g2.example.com').password,
      'shared-pass',
      'password preserved across re-import',
    );

    for (const c of afterReimport) store.deleteConnection(c.id);
    assert.strictEqual(store.listConnectionsForDisplay().length, 0, 'cleaned up imported connections');

    console.log('ALL CHECKS PASSED');
    app.exit(0);
  } catch (err) {
    console.error('FAIL:', err instanceof Error ? err.stack : String(err));
    app.exit(1);
  }
});
