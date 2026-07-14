# macOS code signing with a self-signed certificate (interim)

This is a stopgap until a real Apple Developer ID Application certificate is set up
(requires enrolling in the paid Apple Developer Program). It gets the build/release
pipeline working end to end now, with a **known limitation**: the signed builds it
produces will still trigger Gatekeeper's "Apple could not verify this app is free of
malware" block for anyone who downloads them, because a self-signed certificate doesn't
chain to Apple's CA — only notarization (which requires a real Developer ID) removes
that. Recipients need to right-click the app → Open the first time, or run:

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
4. Find it in Keychain Access, right-click → **Export…**, save as `.p12`, and set an
   export password (you'll need this for the `MACOS_CERTIFICATE_PWD` secret).
5. Base64-encode it for CI:
   ```bash
   base64 -i certificate.p12 | pbcopy
   ```

## Required GitHub secrets

- **`MACOS_CERTIFICATE`** — base64-encoded `.p12` from step 5 above.
- **`MACOS_CERTIFICATE_PWD`** — the export password from step 4.
- **`MACOS_CERTIFICATE_NAME`** — the certificate's exact Common Name (e.g.
  `Developer ID Application: Timebuddy Local`). A self-signed cert won't be picked up by
  `electron-builder`'s default identity search unless it's told exactly which identity to
  use via `CSC_NAME`, which the workflow passes from this secret.

`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are deliberately **not**
configured — `scripts/notarize.js` no-ops (with a warning in the build log) whenever
those are unset, so the build stays signed-but-not-notarized without any code changes.

## Testing locally

```bash
export CSC_LINK=$(base64 -i /path/to/certificate.p12)
export CSC_KEY_PASSWORD="your-p12-export-password"
export CSC_NAME="Developer ID Application: Timebuddy Local"

cd electron && npm run build-mac
```

## Upgrading to a real Developer ID later

Once a real Apple Developer Program enrollment + Developer ID Application certificate
exist, the only changes needed are:

1. Replace `MACOS_CERTIFICATE`/`MACOS_CERTIFICATE_PWD`/`MACOS_CERTIFICATE_NAME` with the
   real certificate's values (see Time Buddy's `APPLE_SIGNING_SETUP.md` for the
   equivalent Apple-issued-cert version of these same steps).
2. Add the `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` secrets — their
   presence is what turns notarizing back on in `scripts/notarize.js`.

No changes to `package.json`'s `build` config, the entitlements, or the workflow
structure are needed.
