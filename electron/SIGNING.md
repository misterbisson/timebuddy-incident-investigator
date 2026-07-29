# macOS code signing and notarization

The macOS build is signed with a real **Apple Developer ID Application** certificate,
**notarized** by Apple, and **stapled** — so a downloaded build opens normally, with no
Gatekeeper block and no `xattr`/"Open Anyway" workaround. (Windows and Linux builds are
still unsigned, same as upstream Time Buddy.)

This replaced an earlier interim setup that used a self-signed certificate (signed but not
notarizable); see the git history of this file if you need that context.

## How CI signs and notarizes

Signing and notarization are done by **electron-builder's native path** — not a custom
`codesign` step. electron-builder signs the app *inside-out* (every nested helper and
framework, with inherited entitlements + hardened runtime + a secure timestamp), which a
manual `codesign --deep` cannot do reliably and which notarization requires.

- **Signing:** `CSC_LINK` (base64 of the Developer ID `.p12`) + `CSC_KEY_PASSWORD`.
  electron-builder imports the `.p12` into its own throwaway keychain and signs.
- **Notarization + stapling:** `mac.notarize: true` in `package.json`, with `APPLE_ID` +
  `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` in the environment. electron-builder
  submits to Apple's notary service (`notarytool`), waits, and staples the ticket.
- **Entitlements:** `build/entitlements.mac.plist` (+ `entitlementsInherit`), with
  `hardenedRuntime: true`.
- `scripts/afterPack.js` strips unused Info.plist usage-description keys — the last
  file mutation before electron-builder signs.

Where it runs:

- **`.github/workflows/release.yml`** — the `release` and `republish` jobs build, sign,
  notarize, and publish/upload the installers.
- **`.github/workflows/verify-signing.yml`** — a clean-room check on every PR that touches
  the app: it builds → signs → notarizes → staples on a fresh macOS runner, then
  **asserts** Developer ID authority, hardened runtime, a secure timestamp, Gatekeeper
  acceptance (`spctl` → `source=Notarized Developer ID`), and a stapled ticket, for both
  `x64` and `arm64`. It also uploads the signed `.dmg` as an artifact for a manual
  open-on-a-clean-Mac check. Runs on a fresh runner precisely so it can't be fooled by a
  developer machine's cached intermediates or pre-trusted keychain.

## Required GitHub secrets

| Secret | What it is |
| --- | --- |
| `MACOS_CERTIFICATE` | base64 of the Developer ID Application `.p12` (certificate **and** private key) |
| `MACOS_CERTIFICATE_PWD` | the `.p12`'s export password |
| `APPLE_ID` | Apple ID email that owns/administers the developer team |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password from [appleid.apple.com](https://appleid.apple.com), generated **while signed into that same Apple ID** |
| `APPLE_TEAM_ID` | the 10-character team id (also the `notarize` team) |

## Creating and exporting the `.p12` (first-time, renewal, or new cert)

1. **CSR:** Keychain Access → *Certificate Assistant → Request a Certificate from a
   Certificate Authority* → **Saved to disk** (leave CA Email blank). The email/name are
   cosmetic — Apple overwrites them on the issued cert. This generates the private key in
   your keychain.
2. **Issue:** [developer.apple.com](https://developer.apple.com/account/resources/certificates)
   → Certificates → **+** → **Developer ID Application** → upload the CSR → download the
   `.cer` → double-click to install it into your **login** keychain (it pairs with the
   CSR's private key).
3. **Export:** Keychain Access → **My Certificates** → the cert (expand the triangle to
   confirm the private key is nested under it) → **Export…** → **Personal Information
   Exchange (.p12)**. You get **two** password prompts, back to back:
   - First — the password that **protects the `.p12`**. This becomes `MACOS_CERTIFICATE_PWD`.
   - Second — your **Mac login** password, to authorize the export. Unrelated; don't reuse it.

   Conflating these two is the #1 cause of `security: SecKeychainItemImport: MAC
   verification failed during PKCS12 import (wrong password?)` in CI.

## Setting / rotating the secrets (validate-before-store)

These helpers **prove each value is correct against the real thing before writing it to
GitHub**, so a bad value fails at your keyboard instead of deep in a CI run. None print or
persist a secret. Edit the placeholders at the top of each.

**Verify a `.p12`** (cert + matching key + you know the password):

```bash
P12="/path/to/DeveloperID.p12"
echo "Enter the .p12 export password when prompted (hidden)."
PEM="$(openssl pkcs12 -in "$P12" -legacy -nodes 2>/dev/null)"   # -legacy: Keychain exports use legacy PBE
[ -n "$PEM" ] || { echo "PASSWORD: FAILED"; exit 1; }
printf '%s\n' "$PEM" | openssl x509 -noout -subject -issuer -enddate
KEY="$(printf '%s\n' "$PEM" | openssl pkey -pubout 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
CRT="$(printf '%s\n' "$PEM" | openssl x509 -pubkey -noout 2>/dev/null | openssl pkey -pubin -pubout 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
[ "$KEY" = "$CRT" ] && echo "KEY MATCHES CERT: YES" || echo "KEY MATCHES CERT: NO"
```

**Set the signing secrets** (only if the password opens the `.p12`):

```bash
P12="/path/to/DeveloperID.p12"; REPO="owner/repo"
read -rs -p "Enter the .p12 export password: " PW; echo; export PW
openssl pkcs12 -in "$P12" -legacy -passin env:PW -nokeys >/dev/null 2>&1 \
  || { echo "Wrong password — nothing changed."; unset PW; exit 1; }
base64 -i "$P12" | tr -d '\n' | gh secret set MACOS_CERTIFICATE -R "$REPO"
printf '%s' "$PW" | gh secret set MACOS_CERTIFICATE_PWD -R "$REPO"
unset PW
```

**Set the notary secrets** (only if Apple accepts them):

```bash
REPO="owner/repo"; TEAM_ID="YOUR_TEAM_ID"   # 10 chars; see: security find-identity -v -p codesigning
read -rp  "Apple ID email (owner of team $TEAM_ID): " APPLE_ID
read -rs -p "App-specific password (generated under that Apple ID): " APP_PW; echo
xcrun notarytool history --apple-id "$APPLE_ID" --team-id "$TEAM_ID" --password "$APP_PW" >/dev/null 2>&1 \
  || { echo "Apple REJECTED the credentials — nothing changed."; unset APP_PW; exit 1; }
printf '%s' "$APPLE_ID" | gh secret set APPLE_ID -R "$REPO"
printf '%s' "$APP_PW"   | gh secret set APPLE_APP_SPECIFIC_PASSWORD -R "$REPO"
printf '%s' "$TEAM_ID"  | gh secret set APPLE_TEAM_ID -R "$REPO"
unset APP_PW
```

## Rotating the certificate — impact on already-installed apps

macOS keys an app's signing identity to the **Team ID + "Developer ID Application"
authority** (the signature's *Designated Requirement*), **not** the specific certificate
serial. So the user impact depends entirely on whether the **team** changes:

- **Same cert, re-exported `.p12`** (new export password, different Mac) — transparent.
  Just update `MACOS_CERTIFICATE` / `MACOS_CERTIFICATE_PWD`.
- **Renewed / new cert, same team** (e.g. before the cert expires) — also **transparent**:
  a renewed same-team cert satisfies the same Designated Requirement, so auto-update
  (Squirrel.Mac) keeps working and Keychain/`safeStorage` isn't disturbed. Update the two
  cert secrets; no code changes. Do this before the old cert expires and it's a non-event.
- **Different Apple account / different Team ID** — **disruptive**: auto-update breaks
  (team mismatch → users must manually reinstall once) and Keychain/`safeStorage` treats
  it as a new app (re-prompt, possibly re-entered connections). You must also update
  `APPLE_TEAM_ID`, the hardcoded `TEAM_ID` in `verify-signing.yml`'s assertions, and ensure
  the notary `APPLE_ID` has access to the new team.

Two edge cases: already-shipped builds keep working after the cert expires (the secure
timestamp + notarization are point-in-time), but a **revoked** cert can make Gatekeeper
reject even installed builds — so protect the `.p12`/private key (keep it in a password
manager, not lying around on disk).

## Building a signed + notarized app locally (optional)

```bash
export CSC_LINK=$(base64 -i /path/to/DeveloperID.p12)
export CSC_KEY_PASSWORD="your-p12-export-password"
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="YOUR_TEAM_ID"

cd electron && npm run build-mac
```

Notarization contacts Apple and can take a few minutes. To sign without notarizing (faster,
for a local smoke test), leave the three `APPLE_*` vars unset and set `mac.notarize` off, or
just check the signature with `codesign -dvv` / `spctl -a -vvv` on the built `.app`.
