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
 * A record with no `kind` predates this field entirely (it was added after
 * Grafana-only connections already existed in the wild) — treat that as
 * 'grafana' rather than migrating stored files, so existing connections keep
 * working with zero user action.
 */
function kindOf(meta) {
  return meta.kind ?? 'grafana';
}

function decryptedSecretFor(meta, secrets) {
  const encoded = secrets[meta.id];
  return encoded ? decryptSecret(encoded) : undefined;
}

function withSecret(meta, secret) {
  return {
    token: secret?.authType === 'bearer' ? secret.token : undefined,
    username: secret?.authType === 'basic' ? secret.username : meta.username,
    password: secret?.authType === 'basic' ? secret.password : undefined,
  };
}

/**
 * Builds the fully-populated GrafanaConnection[] the MCP engine needs
 * (secrets included), decrypting via safeStorage entirely in memory. This
 * is only ever called from this same Electron process's headless
 * --mcp-server mode (see main.js) — the return value is never written back
 * to disk in any form, so no plaintext secret exists anywhere, ever.
 */
function getGrafanaConnectionsForEngine() {
  const { connections } = readConnectionsFile();
  const { secrets } = readSecretsFile();

  return connections
    .filter((meta) => kindOf(meta) === 'grafana')
    .map((meta) => ({
      id: meta.id,
      name: meta.name,
      url: meta.url,
      authType: meta.authType,
      matchHosts: meta.matchHosts,
      tlsVerify: meta.tlsVerify,
      tags: meta.tags,
      ...withSecret(meta, decryptedSecretFor(meta, secrets)),
    }));
}

/** Same rationale as getGrafanaConnectionsForEngine(), for LogConnection[]. */
function getLogConnectionsForEngine() {
  const { connections } = readConnectionsFile();
  const { secrets } = readSecretsFile();

  return connections
    .filter((meta) => kindOf(meta) === 'graylog')
    .map((meta) => ({
      id: meta.id,
      name: meta.name,
      sourceType: 'graylog',
      url: meta.url,
      authType: meta.authType,
      apiVersion: meta.apiVersion ?? 'legacy',
      streamId: meta.streamId,
      streamName: meta.streamName,
      tlsVerify: meta.tlsVerify,
      tags: meta.tags,
      ...withSecret(meta, decryptedSecretFor(meta, secrets)),
    }));
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

  const kind = draft.kind ?? 'grafana';
  const meta = {
    id,
    kind,
    name: draft.name,
    url: draft.url.replace(/\/+$/, ''),
    authType: draft.authType,
    username: draft.authType === 'basic' ? draft.username : undefined,
    tlsVerify: draft.tlsVerify,
    tags: draft.tags,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    // Grafana-only.
    ...(kind === 'grafana' ? { matchHosts: draft.matchHosts } : {}),
    // Graylog-only.
    ...(kind === 'graylog'
      ? { apiVersion: draft.apiVersion ?? 'legacy', streamId: draft.streamId, streamName: draft.streamName }
      : {}),
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

  return { ...meta, hasSecret: Boolean(secretsFile.secrets[id]) };
}

function deleteConnection(id) {
  const connectionsFile = readConnectionsFile();
  const secretsFile = readSecretsFile();

  connectionsFile.connections = connectionsFile.connections.filter((c) => c.id !== id);
  delete secretsFile.secrets[id];

  fs.writeFileSync(connectionsFilePath(), JSON.stringify(connectionsFile, null, 2), 'utf8');
  fs.writeFileSync(secretsFilePath(), JSON.stringify(secretsFile, null, 2), 'utf8');
}

module.exports = {
  listConnectionsForDisplay,
  upsertConnection,
  deleteConnection,
  getGrafanaConnectionsForEngine,
  getLogConnectionsForEngine,
};
