const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { notarize } = require("@electron/notarize");
const { build } = require("../package.json");

// electron-builder/@electron/osx-sign only pick a signing identity via
// `security find-identity -v` (trusted identities only), and a self-signed cert's
// root isn't trusted by macOS by default. Trusting it requires `add-trusted-cert`,
// which needs `com.apple.trust-settings.admin` — on newer macOS runner images
// GitHub no longer lets CI pre-authorize that right, so the step fails outright
// (`NO (-60005)`) instead of just hanging like it used to. `codesign` itself
// doesn't care about trust — only Gatekeeper/verification does — so CI skips
// electron-builder's own (trust-gated) signing entirely and this hook signs
// manually with the identity's hash instead, which only requires the identity to
// exist in the keychain search list.
const codesignApp = appPath => {
  const identityHash = process.env.CODESIGN_IDENTITY_HASH;
  if (!identityHash) {
    console.warn("Skipping manual codesign step. CODESIGN_IDENTITY_HASH not set");
    return;
  }

  execFileSync("codesign", [
    "--force",
    "--deep",
    "--options", "runtime",
    "--entitlements", path.resolve(__dirname, "../build/entitlements.mac.plist"),
    "--sign", identityHash,
    appPath,
  ], { stdio: "inherit" });
};

const notarizeMacos = async (appPath) => {
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) {
    console.warn("Skipping notarizing step. Missing Apple credentials");
    return;
  }

  await notarize({
    tool: "notarytool",
    appBundleId: build.appId,
    appPath,
    teamId: process.env.APPLE_TEAM_ID,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    verbose: true,
  });
  console.log("--- notarization completed ---");
};

const afterSign = async context => {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  codesignApp(appPath);
  await notarizeMacos(appPath);
};

exports.default = afterSign;
