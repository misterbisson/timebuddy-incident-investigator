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
      token: secret?.authType === 'bearer' ? secret.token : undefined,
      username: secret?.authType === 'basic' ? secret.username : meta.username,
      password: secret?.authType === 'basic' ? secret.password : undefined,
    };
  });
  return { connections: built, failures };
}

module.exports = {
  CorruptStoreError,
  SecretDecryptError,
  SecretFormatError,
  STORE_FILE_MODE,
  describeSecretFailure,
  readJsonFile,
  writeJsonFileAtomic,
  buildEngineConnections,
};
