const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function storageDir() {
  return app.getPath('userData');
}

function connectionsFilePath() {
  return path.join(storageDir(), 'connections.json');
}

function secretsFilePath() {
  return path.join(storageDir(), 'secrets.enc.json');
}

function credentialsFilePath() {
  return path.join(storageDir(), 'credentials.json');
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function readConnectionsFile() {
  return readJson(connectionsFilePath(), { version: 1, connections: [] });
}

// secrets.enc.json holds this app's own working copy, encrypted with the OS
// keychain via safeStorage — only this Electron app can ever read it back.
function readSecretsFile() {
  return readJson(secretsFilePath(), { version: 1, secrets: {} });
}

function encryptSecret(payload) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain encryption is not available on this machine; cannot store credentials securely.');
  }
  return safeStorage.encryptString(JSON.stringify(payload)).toString('base64');
}

function decryptSecret(encoded) {
  return JSON.parse(safeStorage.decryptString(Buffer.from(encoded, 'base64')));
}

/**
 * Writes credentials.json, the MCP server's read path — 0600-permissioned
 * plaintext, because a plain Node stdio process can't call safeStorage.
 * This is the one deliberate tradeoff in this design: Electron's own copy
 * (secrets.enc.json) stays OS-keychain-encrypted; this hand-off file is the
 * same posture as ~/.aws/credentials or a kubeconfig. See NOTICE.md.
 */
function rewriteCredentialsFile(connections, secretsFile) {
  const credentials = {};
  for (const conn of connections) {
    const encoded = secretsFile.secrets[conn.id];
    if (!encoded) continue;
    credentials[conn.id] = decryptSecret(encoded);
  }
  const file = { version: 1, credentials };
  fs.writeFileSync(credentialsFilePath(), JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(credentialsFilePath(), 0o600);
}

/** Non-secret connection list for the UI table — never includes a password/token. */
function listConnectionsForDisplay() {
  const { connections } = readConnectionsFile();
  const { secrets } = readSecretsFile();
  return connections.map((c) => ({ ...c, hasSecret: Boolean(secrets[c.id]) }));
}

/**
 * Creates or updates a connection. Leaving `password`/`token` blank on an
 * edit keeps the existing stored secret (same behavior as Time Buddy's
 * connection form) — only a non-empty value overwrites it.
 */
function upsertConnection(draft) {
  const connectionsFile = readConnectionsFile();
  const secretsFile = readSecretsFile();

  const now = draft.updatedAt ?? new Date(0).toISOString();
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

  fs.mkdirSync(storageDir(), { recursive: true });
  fs.writeFileSync(connectionsFilePath(), JSON.stringify(connectionsFile, null, 2), 'utf8');
  fs.writeFileSync(secretsFilePath(), JSON.stringify(secretsFile, null, 2), 'utf8');
  rewriteCredentialsFile(connectionsFile.connections, secretsFile);

  return { ...meta, hasSecret: Boolean(secretsFile.secrets[id]) };
}

function deleteConnection(id) {
  const connectionsFile = readConnectionsFile();
  const secretsFile = readSecretsFile();

  connectionsFile.connections = connectionsFile.connections.filter((c) => c.id !== id);
  delete secretsFile.secrets[id];

  fs.writeFileSync(connectionsFilePath(), JSON.stringify(connectionsFile, null, 2), 'utf8');
  fs.writeFileSync(secretsFilePath(), JSON.stringify(secretsFile, null, 2), 'utf8');
  rewriteCredentialsFile(connectionsFile.connections, secretsFile);
}

module.exports = {
  storageDir,
  listConnectionsForDisplay,
  upsertConnection,
  deleteConnection,
};
