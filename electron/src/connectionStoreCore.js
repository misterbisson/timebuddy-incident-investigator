const fs = require('node:fs');
const path = require('node:path');

/**
 * The parts of connectionStore.js that don't need Electron. Deliberately
 * imports nothing from `electron` — `safeStorage`'s decrypt is a parameter and
 * paths are arguments — for the same reason authGuard.js doesn't: CI installs
 * with `--workspaces=false` (see .github/workflows/ci.yml), so there is no
 * Electron binary there, and anything that reaches for `app`/`safeStorage` at
 * require time can't be unit-tested at all. This is the file where the
 * store's failure modes actually live, so it's the one that most needs tests.
 */

class CorruptStoreError extends Error {}

/** The keychain refused the ciphertext — re-entering the credential fixes it. */
class SecretDecryptError extends Error {}
/** Decryption succeeded, but the plaintext wasn't the JSON payload we store. */
class SecretFormatError extends Error {}

/**
 * A user-supplied import manifest is structurally wrong. Carries *every*
 * problem found rather than just the first, so someone fixing a 20-connection
 * file sees the whole list in one pass instead of one round trip per mistake.
 */
class ImportValidationError extends Error {
  constructor(problems) {
    super(`connection manifest is not valid:\n- ${problems.join('\n- ')}`);
    this.name = 'ImportValidationError';
    this.problems = problems;
  }
}

/**
 * Turns a secret failure into a message safe to log and to show in the GUI.
 *
 * Never returns the underlying error's own message, and that restriction is
 * the entire point rather than tidiness. `decryptSecret` is a decrypt followed
 * by a JSON.parse, and V8 embeds a prefix of the input in a parse failure:
 *
 *   Unexpected token 'g', "glsa_SUPER"... is not valid JSON
 *
 * That string reaches console.error (captured to the MCP client's log files on
 * disk) and the connection row's tooltip. So a *successful* decrypt whose
 * payload isn't our JSON would publish the first ~10 characters of a live
 * credential. Reachable via Linux's `basic_text` safeStorage fallback, or a
 * partly-corrupted base64 blob — Buffer.from(x, 'base64') silently drops
 * invalid characters rather than throwing.
 *
 * Distinguishing the two cases also stops a misdiagnosis: only the keychain
 * case is fixed by re-entering the credential, which is what the GUI and
 * README tell the user to do.
 */
function describeSecretFailure(err) {
  if (err instanceof SecretFormatError) {
    return 'stored credential decrypted but is not in the expected format; re-save this connection to rewrite it';
  }
  return 'the OS keychain could not decrypt the stored credential (most often after an OS reinstall, keychain reset, or machine migration)';
}

/**
 * Reads a JSON store file. A missing file is normal (first run) and yields the
 * fallback; unparseable content is not, and throws.
 *
 * Throwing is what the previous implementation already did — a SyntaxError has
 * no `.code`, so it fell past the ENOENT check and propagated. What changes
 * here is only the message: a bare "Unexpected end of JSON input" names no
 * file and suggests no action, and this is the error a user hits when their
 * app stops working entirely.
 *
 * Keeping the throw is deliberate, though, and worth recording because the
 * engine's own caches do the opposite (src/index-builder/store.ts,
 * src/knowledge/store.ts swallow parse errors and rebuild). That's right for a
 * cache, whose contents are derivable, and wrong here: falling back to "no
 * connections" would let the next upsertConnection write that empty state back
 * over the file, turning a recoverable truncation into permanent loss of every
 * other connection. Failing loudly keeps the damaged bytes on disk where they
 * can still be repaired.
 */
function readJsonFile(filePath, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CorruptStoreError(
      `${filePath} is not valid JSON and was left untouched rather than overwritten: ${err.message}. ` +
        'This usually means a write was interrupted by an earlier version of this app (writes are now atomic). ' +
        'Move or repair that file to continue; deleting it discards the connections it holds.',
    );
  }
}

/** Owner-only. These files hold (encrypted) credentials; nothing else needs to read them. */
const STORE_FILE_MODE = 0o600;

/**
 * Writes via a temp file plus rename — a reader sees either the whole old file
 * or the whole new one, never a truncated prefix. The fsync before the rename
 * is a separate guarantee: rename ordering protects against a torn file, not
 * against the new bytes never having reached the disk.
 *
 * The temp file is created in the same directory on purpose, since rename is
 * only atomic within a filesystem and the OS temp dir often isn't on the same
 * one.
 *
 * One platform caveat worth stating rather than implying: on Windows this goes
 * through MoveFileExW with MOVEFILE_REPLACE_EXISTING, which is atomic but can
 * fail EPERM/EBUSY when another process holds the target open. That's
 * reachable here — a GUI instance and one or more --mcp-server instances run
 * concurrently — so the write surfaces an error rather than corrupting
 * anything, which is the acceptable end of that trade but not "it always
 * succeeds".
 *
 * Mode is set explicitly, and this is easy to get wrong: rename replaces the
 * target *inode*, so the temp file's permissions are what survive — the
 * destination's are discarded. A plain openSync(tmp, 'w') creates 0666 & ~umask
 * (0644 on a default umask), which would silently widen this file on every
 * single write, and make a fresh install world-readable from its first one.
 * The explicit fchmod after the open is what makes it umask-proof, since the
 * mode argument to open is itself masked.
 *
 * The parent userData directory is usually 0700, but a credential store
 * shouldn't borrow its confidentiality from its parent. It matters most on
 * Linux, where safeStorage falls back to a `basic_text` backend with a
 * hardcoded key when no keyring is available — world-readable ciphertext there
 * is effectively plaintext.
 */
function writeJsonFileAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w', STORE_FILE_MODE);
    try {
      fs.fchmodSync(fd, STORE_FILE_MODE);
      fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Covers the whole sequence, not just the rename: an ENOSPC during write
    // or fsync would otherwise strand a temp file holding a complete-or-partial
    // encrypted secrets blob, one per distinct pid, accumulating across
    // restarts.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the original error is the one worth reporting */
    }
    throw err;
  }
  // The rename's own durability. fsync on the file guarantees its contents
  // survive a power loss; only fsync on the containing directory guarantees
  // the renamed *entry* does. Without it the two store files can be recovered
  // in the opposite order from the one writeStoreFiles deliberately chose.
  // Best-effort: opening a directory for fsync throws EPERM/EISDIR on Windows.
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* not supported on this platform; the rename itself is still atomic */
  }
}

/**
 * Assembles the engine's GrafanaConnection[] from stored metadata plus
 * decrypted secrets, isolating each connection's decrypt.
 *
 * safeStorage.decryptString throws whenever the keychain entry no longer
 * matches the ciphertext — an OS reinstall, a keychain reset, a machine
 * migration, or an app.setName change (the risk main.js's own header comment
 * calls out). Because this runs on *every* tool call via the ConnectionsSource
 * thunk, letting one such throw escape meant a single stale connection made
 * every tool call fail, including calls that never touch it, with an error
 * naming no connection at all.
 *
 * A connection whose secret won't decrypt is still returned, just without its
 * credential. That's deliberate rather than dropping it: the engine's own
 * buildAuthHeader already throws `Connection "<id>" is authType=... but
 * missing token` at the point of use, so the failure stays scoped to the one
 * connection and names it, while resolveConnection's "available connections"
 * list stays honest about what's configured. Dropping it instead would make
 * the connection appear to have never existed.
 */
function buildEngineConnections(connections, secrets, decrypt) {
  const failures = [];
  const built = connections.map((meta) => {
    let secret;
    const encoded = secrets[meta.id];
    if (encoded) {
      try {
        secret = decrypt(encoded);
      } catch (err) {
        failures.push({ id: meta.id, name: meta.name, reason: describeSecretFailure(err) });
      }
    }
    return {
      id: meta.id,
      name: meta.name,
      url: meta.url,
      authType: meta.authType,
      matchHosts: meta.matchHosts,
      tlsVerify: meta.tlsVerify,
      tags: meta.tags,
      token: secret?.authType === 'bearer' ? secret.token : undefined,
      username: secret?.authType === 'basic' ? secret.username : meta.username,
      password: secret?.authType === 'basic' ? secret.password : undefined,
    };
  });
  return { connections: built, failures };
}

/**
 * Log-connection counterpart to buildEngineConnections() — same
 * isolate-each-decrypt contract (see that function's doc comment for why),
 * mapped to Graylog's LogConnection shape instead of GrafanaConnection's.
 *
 * Graylog authType is 'token' | 'basic', not Grafana's 'bearer' | 'basic':
 * Graylog's REST API doesn't accept a real `Authorization: Bearer` header for
 * API-token auth — its documented convention is HTTP Basic with the token as
 * the username and the literal string "token" as the password. 'basic' here
 * is a real username/password login, same as Grafana's 'basic'.
 */
function buildLogEngineConnections(connections, secrets, decrypt) {
  const failures = [];
  const built = connections.map((meta) => {
    let secret;
    const encoded = secrets[meta.id];
    if (encoded) {
      try {
        secret = decrypt(encoded);
      } catch (err) {
        failures.push({ id: meta.id, name: meta.name, reason: describeSecretFailure(err) });
      }
    }
    return {
      id: meta.id,
      name: meta.name,
      sourceType: 'graylog',
      url: meta.url,
      authType: meta.authType,
      streamId: meta.streamId,
      streamName: meta.streamName,
      tlsVerify: meta.tlsVerify,
      tags: meta.tags,
      token: secret?.authType === 'token' ? secret.token : undefined,
      username: secret?.authType === 'basic' ? secret.username : meta.username,
      password: secret?.authType === 'basic' ? secret.password : undefined,
    };
  });
  return { connections: built, failures };
}

/**
 * Normalizes a URL to the form the idempotency key compares on. It must match
 * how upsertConnection actually stores the URL (`.replace(/\/+$/, '')`, plus a
 * trim, since the renderer trims but a hand-authored manifest might not), or a
 * `…/` in the file and a `…` on disk would read as two different connections
 * and the import would duplicate instead of update.
 *
 * Deliberately does *not* lowercase or otherwise canonicalize the host: it
 * compares against the exact stored string, so what "already exists" stays
 * predictable rather than depending on rules a user can't see.
 */
function normalizeUrlForKey(url) {
  return String(url).trim().replace(/\/+$/, '');
}

/** kind -> the authTypes valid for it. Grafana is bearer/basic; Graylog's
 *  API-token auth is 'token' (HTTP Basic under the hood — see buildLogEngineConnections). */
const IMPORT_AUTH_TYPES = {
  grafana: ['bearer', 'basic'],
  graylog: ['token', 'basic'],
};

function importKey(kind, url) {
  return `${kind}\n${normalizeUrlForKey(url)}`;
}

function validateOptionalStringArray(value, label, problems) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    problems.push(`${label}: must be an array of strings`);
    return undefined;
  }
  const cleaned = value.map((v) => v.trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}

/**
 * Validates and normalizes a metadata-only import manifest into a list of
 * connection entries ready for planImport(). Accepts either `{ version: 1,
 * connections: [...] }` or a bare `[...]` array.
 *
 * Two rules are load-bearing rather than cosmetic:
 *  - **No secrets in the file.** A `token`/`password` on any entry is a hard
 *    error, not silently ignored — the whole point of the manifest is that it's
 *    safe to keep in a repo, and credentials are entered after import.
 *  - **No duplicate url+kind within the file.** That pair is the idempotency
 *    key; two entries sharing it would race to update the same connection, so
 *    it's rejected up front rather than resolved last-wins.
 *
 * Throws ImportValidationError with the full problem list on any failure.
 */
function validateImportManifest(raw) {
  const rawList = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? raw.connections
      : undefined;

  if (!Array.isArray(raw) && raw && typeof raw === 'object' && raw.version !== undefined && raw.version !== 1) {
    throw new ImportValidationError([
      `unsupported manifest version ${JSON.stringify(raw.version)}; this app understands version 1`,
    ]);
  }
  if (!Array.isArray(rawList)) {
    throw new ImportValidationError([
      'expected a JSON object with a "connections" array, or a bare array of connections',
    ]);
  }

  const problems = [];
  const connections = [];
  const seenKeys = new Map(); // key -> the 1-based position of the entry that first claimed it

  rawList.forEach((entry, i) => {
    const label =
      entry && typeof entry === 'object' && typeof entry.name === 'string' && entry.name.trim()
        ? `"${entry.name.trim()}"`
        : `#${i + 1}`;

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`connection ${label}: must be an object`);
      return;
    }

    for (const secretField of ['token', 'password']) {
      if (entry[secretField] !== undefined) {
        problems.push(
          `connection ${label}: remove "${secretField}" — the manifest must not contain secrets; ` +
            'credentials are entered after import',
        );
      }
    }

    const { kind } = entry;
    if (kind !== 'grafana' && kind !== 'graylog') {
      problems.push(`connection ${label}: "kind" must be "grafana" or "graylog"`);
      return; // nothing kind-specific can be checked without a valid kind
    }

    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) problems.push(`connection ${label}: "name" is required`);
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!url) problems.push(`connection ${label}: "url" is required`);
    const { authType } = entry;
    const authValid = IMPORT_AUTH_TYPES[kind].includes(authType);
    if (!authValid) {
      const allowed = IMPORT_AUTH_TYPES[kind].map((a) => `"${a}"`).join(' or ');
      problems.push(`connection ${label}: "authType" must be ${allowed} for a ${kind} connection`);
    }
    if (entry.tlsVerify !== undefined && typeof entry.tlsVerify !== 'boolean') {
      problems.push(`connection ${label}: "tlsVerify" must be true or false`);
    }
    if (entry.username !== undefined && typeof entry.username !== 'string') {
      problems.push(`connection ${label}: "username" must be a string`);
    }

    const tags = validateOptionalStringArray(entry.tags, `connection ${label}: "tags"`, problems);
    let matchHosts;
    if (kind === 'grafana') {
      matchHosts = validateOptionalStringArray(entry.matchHosts, `connection ${label}: "matchHosts"`, problems);
    } else {
      if (entry.streamId !== undefined && typeof entry.streamId !== 'string') {
        problems.push(`connection ${label}: "streamId" must be a string`);
      }
      if (entry.streamName !== undefined && typeof entry.streamName !== 'string') {
        problems.push(`connection ${label}: "streamName" must be a string`);
      }
    }

    // Only build (and key) a normalized entry once its essentials are sound —
    // the problems above already explain anything dropped here.
    if (!name || !url || !authValid) return;

    const key = importKey(kind, url);
    if (seenKeys.has(key)) {
      problems.push(
        `connection ${label}: duplicate url+kind — connection #${seenKeys.get(key)} in this file already uses it`,
      );
      return;
    }
    seenKeys.set(key, i + 1);

    const normalized = {
      kind,
      name,
      url,
      authType,
      tlsVerify: entry.tlsVerify ?? true,
    };
    if (tags) normalized.tags = tags;
    if (typeof entry.username === 'string' && entry.username.trim()) normalized.username = entry.username.trim();
    if (kind === 'grafana') {
      if (matchHosts) normalized.matchHosts = matchHosts;
    } else {
      if (typeof entry.streamId === 'string' && entry.streamId.trim()) normalized.streamId = entry.streamId.trim();
      if (typeof entry.streamName === 'string' && entry.streamName.trim()) normalized.streamName = entry.streamName.trim();
    }
    connections.push(normalized);
  });

  if (problems.length) throw new ImportValidationError(problems);
  if (connections.length === 0) throw new ImportValidationError(['the manifest contains no connections']);
  return { connections };
}

/**
 * Decides, per normalized entry, whether importing it creates a new connection
 * or updates an existing one — matched on url+kind (the chosen idempotency key).
 * Pure: it reads the existing connection metadata and returns a plan; the
 * caller (importConnections) is what actually writes. `existingId` is carried
 * through so the update path can upsert in place rather than duplicate.
 *
 * Connections predating the `kind` field are all Grafana (same convention as
 * getConnectionsForEngine), so a missing kind keys as 'grafana'.
 */
function planImport(entries, existingConnections) {
  const existingByKey = new Map();
  for (const c of existingConnections) {
    existingByKey.set(importKey(c.kind ?? 'grafana', c.url), c.id);
  }
  const plan = entries.map((entry) => {
    const existingId = existingByKey.get(importKey(entry.kind, entry.url));
    return { action: existingId ? 'update' : 'create', entry, existingId };
  });
  return { plan };
}

module.exports = {
  CorruptStoreError,
  SecretDecryptError,
  SecretFormatError,
  ImportValidationError,
  STORE_FILE_MODE,
  describeSecretFailure,
  readJsonFile,
  writeJsonFileAtomic,
  buildEngineConnections,
  buildLogEngineConnections,
  normalizeUrlForKey,
  validateImportManifest,
  planImport,
};
