const { execFileSync } = require("node:child_process");

// Electron's bundled default Info.plist template includes generic usage-description
// strings for hardware this app never touches — unused permission entries that make
// automated scanners (and reviewers) flag the app as requesting access it doesn't
// need. Strip them here, in afterPack: this is the last file-mutation point before
// code signing (see afterSign.js) — editing Info.plist after signing would invalidate
// the signature.
const UNUSED_USAGE_DESCRIPTION_KEYS = [
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
];

const afterPack = async context => {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const infoPlistPath = `${appOutDir}/${appName}.app/Contents/Info.plist`;

  for (const key of UNUSED_USAGE_DESCRIPTION_KEYS) {
    try {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, infoPlistPath]);
    } catch {
      // Key not present in this Electron version's default template — nothing to remove.
    }
  }
};

exports.default = afterPack;
