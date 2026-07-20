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

/**
 * Writes via a temp file plus rename, which is atomic on macOS, Linux, and
 * Windows — a reader either sees the whole old file or the whole new one,
 * never a truncated prefix. The fsync before the rename matters separately:
 * rename ordering alone guarantees atomicity against a crash, not that the
 * new bytes reached the disk before the rename did.
 *
 * The temp file is created in the same directory on purpose, since rename is
 * only atomic within a filesystem and the OS temp dir often isn't on the same
 * one.
 */
function writeJsonFileAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Don't leave the temp file behind if the rename itself failed.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the rename error is the one worth reporting */
    }
    throw err;
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
        failures.push({ id: meta.id, name: meta.name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      id: meta.id,
      name: meta.name,
      url: meta.url,
      authType: meta.authType,
      matchHosts: meta.matchHosts,
      tlsVerify: meta.tlsVerify,
      token: secret?.authType === 'bearer' ? secret.token : undefined,
      username: secret?.authType === 'basic' ? secret.username : meta.username,
      password: secret?.authType === 'basic' ? secret.password : undefined,
    };
  });
  return { connections: built, failures };
}

module.exports = { CorruptStoreError, readJsonFile, writeJsonFileAtomic, buildEngineConnections };
