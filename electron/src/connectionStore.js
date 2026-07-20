const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  readJsonFile,
  writeJsonFileAtomic,
  buildEngineConnections,
  describeSecretFailure,
  SecretDecryptError,
  SecretFormatError,
} = require('./connectionStoreCore.js');

function storageDir() {
  return app.getPath('userData');
}

function connectionsFilePath() {
  return path.join(storageDir(), 'connections.json');
}

function secretsFilePath() {
  return path.join(storageDir(), 'secrets.enc.json');
}

function readConnectionsFile() {
  return readJsonFile(connectionsFilePath(), { version: 1, connections: [] });
}

// secrets.enc.json holds this app's own working copy, encrypted with the OS
// keychain via safeStorage — only this Electron app can ever read it back.
function readSecretsFile() {
  return readJsonFile(secretsFilePath(), { version: 1, secrets: {} });
}

/**
 * Both files are written atomically, but they're still two files: a crash
 * between them leaves them briefly out of step. The order below decides which
 * way that skew falls, so it isn't arbitrary.
 *
 * Secrets are written first on write and last on delete, which makes an
 * orphaned secret (encrypted, unreferenced, invisible) the only reachable
 * intermediate state. The opposite order would leave a connection listed in
 * connections.json whose secret hasn't landed yet — the exact "connection
 * exists but won't authenticate" state this change is otherwise about
 * eliminating.
 */
function writeStoreFiles(connectionsFile, secretsFile, order) {
  fs.mkdirSync(storageDir(), { recursive: true });
  if (order === 'secrets-first') {
    writeJsonFileAtomic(secretsFilePath(), secretsFile);
    writeJsonFileAtomic(connectionsFilePath(), connectionsFile);
  } else {
    writeJsonFileAtomic(connectionsFilePath(), connectionsFile);
    writeJsonFileAtomic(secretsFilePath(), secretsFile);
  }
}

function encryptSecret(payload) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain encryption is not available on this machine; cannot store credentials securely.');
  }
  return safeStorage.encryptString(JSON.stringify(payload)).toString('base64');
}

/**
 * Split into two try blocks on purpose. A single try around both operations
 * lets a JSON.parse failure — whose message quotes a prefix of its input —
 * carry decrypted credential material into logs and the GUI. See
 * describeSecretFailure in connectionStoreCore.js. Neither branch re-throws
 * the original error, only a typed one with no payload attached.
 */
function decryptSecret(encoded) {
  let plaintext;
  try {
    plaintext = safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    throw new SecretDecryptError('keychain could not decrypt the stored credential');
  }
  try {
    return JSON.parse(plaintext);
  } catch {
    throw new SecretFormatError('stored credential is not in the expected format');
  }
}

/**
 * Builds the fully-populated GrafanaConnection[] the MCP engine needs
 * (secrets included), decrypting via safeStorage entirely in memory. This
 * is only ever called from this same Electron process's headless
 * --mcp-server mode (see main.js) — the return value is never written back
 * to disk in any form, so no plaintext secret exists anywhere, ever.
 */
function getConnectionsForEngine() {
  const { connections } = readConnectionsFile();
  const { secrets } = readSecretsFile();
  const { connections: built, failures } = buildEngineConnections(connections, secrets, decryptSecret);

  for (const failure of failures) {
    // console.error, not console.log — in --mcp-server mode stdout is the
    // JSON-RPC channel. This is the only place the *reason* is visible; the
    // per-call error the engine raises can only say the credential is missing.
    console.error(
      `Connection "${failure.name}" (${failure.id}): stored credential could not be decrypted, so this connection ` +
        `will fail to authenticate until its credential is re-entered. Other connections are unaffected. ` +
        `Cause: ${failure.reason}`,
    );
  }
  return built;
}

/**
 * Non-secret connection list for the UI table — never includes a
 * password/token. `secretError` distinguishes "a secret is stored but this
 * machine can no longer decrypt it" from "no secret was ever saved": the two
 * look identical to the engine, but only the first is fixed by re-entering
 * the credential, so the UI has to be able to say which one it is.
 *
 * Answering that does require attempting the decrypt — there's no cheaper
 * probe; whether the keychain still accepts this ciphertext is only knowable
 * by asking it. The plaintext is deliberately never bound to a variable here,
 * and `secretError` carries only describeSecretFailure's fixed text, so no
 * credential material can reach the renderer even though this function
 * decrypts. That distinction is what keeps the doc comment above true.
 */
function listConnectionsForDisplay() {
  const { connections } = readConnectionsFile();
  const { secrets } = readSecretsFile();
  return connections.map((c) => {
    const encoded = secrets[c.id];
    let secretError;
    if (encoded) {
      try {
        decryptSecret(encoded);
      } catch (err) {
        secretError = describeSecretFailure(err);
      }
    }
    return { ...c, hasSecret: Boolean(encoded), ...(secretError ? { secretError } : {}) };
  });
}

/**
 * Creates or updates a connection. Leaving `password`/`token` blank on an
 * edit keeps the existing stored secret (same behavior as Time Buddy's
 * connection form) — only a non-empty value overwrites it.
 */
function upsertConnection(draft) {
  const connectionsFile = readConnectionsFile();
  const secretsFile = readSecretsFile();

  // The renderer's readDraft() never sets updatedAt, so the `?? new Date(0)`
  // this replaces meant every connection was stamped 1970-01-01 in practice.
  const now = draft.updatedAt ?? new Date().toISOString();
  const existingIndex = draft.id ? connectionsFile.connections.findIndex((c) => c.id === draft.id) : -1;
  const id = draft.id ?? crypto.randomUUID();
  const existing = existingIndex >= 0 ? connectionsFile.connections[existingIndex] : undefined;

  const meta = {
    id,
    name: draft.name,
    url: draft.url.replace(/\/+$/, ''),
    authType: draft.authType,
    username: draft.authType === 'basic' ? draft.username : undefined,
    matchHosts: draft.matchHosts,
    tlsVerify: draft.tlsVerify,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    connectionsFile.connections[existingIndex] = meta;
  } else {
    connectionsFile.connections.push(meta);
  }

  const hasNewSecret =
    draft.authType === 'basic' ? Boolean(draft.password) : Boolean(draft.token);
  if (hasNewSecret) {
    const payload =
      draft.authType === 'basic'
        ? { authType: 'basic', username: draft.username, password: draft.password }
        : { authType: 'bearer', token: draft.token };
    secretsFile.secrets[id] = encryptSecret(payload);
  }

  writeStoreFiles(connectionsFile, secretsFile, 'secrets-first');

  return { ...meta, hasSecret: Boolean(secretsFile.secrets[id]) };
}

function deleteConnection(id) {
  const connectionsFile = readConnectionsFile();
  const secretsFile = readSecretsFile();

  connectionsFile.connections = connectionsFile.connections.filter((c) => c.id !== id);
  delete secretsFile.secrets[id];

  writeStoreFiles(connectionsFile, secretsFile, 'connections-first');
}

module.exports = {
  listConnectionsForDisplay,
  upsertConnection,
  deleteConnection,
  getConnectionsForEngine,
};
