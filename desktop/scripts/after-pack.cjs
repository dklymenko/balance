const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const plist = require("plist");

const unusedPrivacyKeys = [
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
];

module.exports = async function hardenMacBundle(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const infoPath = join(context.appOutDir, `${appName}.app`, "Contents", "Info.plist");
  const info = plist.parse(readFileSync(infoPath, "utf8"));

  // electron-builder enables arbitrary loads to support localhost by default.
  // Balance needs loopback HTTP only, not unrestricted clear-text networking.
  info.NSAppTransportSecurity = {
    NSAllowsArbitraryLoads: false,
    NSAllowsLocalNetworking: true,
  };
  for (const key of unusedPrivacyKeys) delete info[key];

  writeFileSync(infoPath, plist.build(info));
};
