# macOS code signing with a self-signed certificate (interim)

This is a stopgap until a real Apple Developer ID Application certificate is set up
(requires enrolling in the paid Apple Developer Program). It gets the build/release
pipeline working end to end now, with a **known limitation**: the signed builds it
produces will still trigger Gatekeeper's "Apple could not verify this app is free of
malware" block for anyone who downloads them, because a self-signed certificate doesn't
chain to Apple's CA — only notarization (which requires a real Developer ID) removes
that. On current macOS, this block is no longer clearable with the old right-click →
Open trick; recipients need to go through System Settings → Privacy & Security → Open
Anyway — see [`README.md`](README.md#installing-a-downloaded-build-macos) for the full
click-through with screenshots. Or, on the command line:

```bash
xattr -d com.apple.quarantine "/Applications/Timebuddy Incident Investigator.app"
```

What the self-signed cert *does* buy in the meantime:
- A stable code signing identity, so macOS Keychain treats every build as the same app
  and doesn't re-prompt for keychain access (needed by `safeStorage`) on every rebuild.
- `hardenedRuntime` and the entitlements in `build/entitlements.mac.plist` actually get
  applied and exercised, so the config is already correct when a real cert replaces this
  one — swapping certs later is just changing which identity signs, not restructuring
  the build.

## Creating the certificate

1. Open **Keychain Access** → menu bar **Keychain Access → Certificate Assistant →
   Create a Certificate…**
2. Name it starting with `Developer ID Application:` (e.g.
   `Developer ID Application: Timebuddy Local`) — this isn't required for local builds,
   but keeping the same naming convention Apple uses means `electron-builder`'s identity
   auto-discovery behaves the same way it will once this is swapped for a real cert.
3. **Identity Type**: Self-Signed Root. **Certificate Type**: Code Signing. Leave "Let me
   override defaults" unchecked unless you need a longer validity period.
4. `.p12` export only works on an **identity** (certificate + its private key together) —
   not on the certificate alone. Certificate Assistant generates both and stores them in
   the same keychain, but Keychain Access only shows them paired under the **My
   Certificates** category in the sidebar, not under plain **Certificates** (which lists
   certs without their keys and only offers `.cer`/`.pem` export). So: click **My
   Certificates** in the sidebar, find the cert there (it has a disclosure triangle you
   can expand to see the paired private key underneath), select it, and **File → Export
   Items…** (or right-click → Export). `.p12` should now be an option. Exporting shows
   **two separate password prompts, back to back** — easy to conflate:
   - First, a dialog to **"enter a password which you will use to protect the exported
     items"** — this becomes the `.p12`'s own encryption password. This is the one you
     need for `MACOS_CERTIFICATE_PWD`/`CSC_KEY_PASSWORD`.
   - Immediately after, a **separate system dialog** asking for your Mac login/keychain
     password to authorize the export — unrelated to the `.p12` file itself, don't reuse
     this one as the export password.

   Getting these two swapped is the most common cause of `security import`/
   `electron-builder` failing with `MAC verification failed during PKCS12 import (wrong
   password?)` even though "a" password was set correctly.

   If it's still not showing under **My Certificates**, the private key may have landed
   in a different keychain than the certificate (e.g. `login` vs a custom keychain) — check
   under **Keys** for one named after your identity and, if needed, drag it into the same
   keychain as the certificate. As a fallback, the `security` CLI can export an identity
   directly (it requires `-t identities`, not `-t certs`, to pull in the private key).
   Without a name filter this exports *every* identity in the target keychain into one
   `.p12` — fine if `login.keychain` only has this one, but check first
   (`security find-identity -v`) since a work Mac's `login` keychain often has VPN/MDM
   identities too; if so, create the certificate in (or move it to) a scratch keychain and
   export from that instead:
   ```bash
   security find-identity -v -p codesigning   # confirm it's listed as a valid identity
   security export -k login.keychain -t identities -f pkcs12 -o certificate.p12
   ```
5. Base64-encode it for CI:
   ```bash
   base64 -i certificate.p12 | pbcopy
   ```
6. **Trust the certificate for code signing.** Importing/exporting the `.p12` is not
   enough by itself — `electron-builder` picks a signing identity via
   `security find-identity -v` (valid identities only), and macOS doesn't trust a
   self-signed root by default no matter which keychain it's in. Without this step,
   builds silently fall back to **unsigned** with a
   `cannot find valid "Developer ID Application" identity ... 0 valid identities found`
   warning, even though `CSC_NAME` matched the identity in the full (untrusted) list.

   In Keychain Access: find the certificate, double-click it, expand **Trust**, set
   **Code Signing** to **Always Trust**, close the panel (enter your Mac password when
   prompted). Confirm it worked:
   ```bash
   security find-identity -v -p codesigning   # should now list it without CSSMERR_TP_NOT_TRUSTED
   ```
   CLI equivalent, if you'd rather not use the GUI (needs the cert alone, not the `.p12`):
   ```bash
   openssl pkcs12 -in certificate.p12 -passin pass:'your-p12-export-password' -clcerts -nokeys -legacy -out certificate.pem
   security add-trusted-cert -r trustRoot -p codeSign -k login.keychain-db certificate.pem
   ```
   **CI does not do this step.** A headless runner can never dismiss the GUI
   trust-confirmation dialog `add-trusted-cert` normally pops, and newer macOS runner
   images (`macos-26-arm64`) also deny the `authorizationdb` pre-authorization that
   used to let CI skip that dialog non-interactively — `add-trusted-cert` now fails
   outright (`NO (-60005)`) instead of hanging. `codesign` itself doesn't check trust
   (only Gatekeeper/verification does), so CI sidesteps the whole problem: it looks up
   the imported identity's hash via the untrusted-inclusive `security find-identity`
   (no `-v`) and passes it to a manual `codesign --sign <hash>` call in `afterSign`
   (`electron/scripts/afterSign.js`) instead of letting `electron-builder` pick a
   (trusted-only) identity itself — see `.github/workflows/release.yml`'s "Import
   signing certificate" step and `CSC_IDENTITY_AUTO_DISCOVERY: "false"` on the build
   step.

## Required GitHub secrets

- **`MACOS_CERTIFICATE`** — base64-encoded `.p12` from step 5 above.
- **`MACOS_CERTIFICATE_PWD`** — the export password from step 4.

`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are deliberately **not**
configured — `scripts/afterSign.js` no-ops the notarize step (with a warning in the
build log) whenever those are unset, so the build stays signed-but-not-notarized
without any code changes.

## Testing locally

```bash
export CSC_LINK=$(base64 -i /path/to/certificate.p12)
export CSC_KEY_PASSWORD="your-p12-export-password"
export CSC_NAME="Timebuddy Local"   # no "Developer ID Application:" prefix — see note above

cd electron && npm run build-mac
```

## Upgrading to a real Developer ID later

Once a real Apple Developer Program enrollment + Developer ID Application certificate
exist, the only changes needed are:

1. Replace `MACOS_CERTIFICATE`/`MACOS_CERTIFICATE_PWD` with the real certificate's
   values (see Time Buddy's `APPLE_SIGNING_SETUP.md` for the equivalent
   Apple-issued-cert version of these same steps).
2. Add the `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` secrets — their
   presence is what turns notarizing back on in `scripts/afterSign.js`.

No changes to `package.json`'s `build` config, the entitlements, or the workflow
structure are needed.
