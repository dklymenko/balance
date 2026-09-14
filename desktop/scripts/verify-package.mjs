import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import plist from "plist";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(desktopDir, "release");

function findFiles(root, name, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) findFiles(path, name, out);
    else if (entry === name) out.push(path);
  }
  return out;
}

const asars = findFiles(releaseDir, "app.asar");
if (asars.length === 0) {
  throw new Error(`No packaged app.asar found under ${releaseDir}`);
}
const violations = [];

const apps = [];
function findApps(root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (!statSync(path).isDirectory()) continue;
    if (entry.endsWith(".app")) apps.push(path);
    else findApps(path);
  }
}
findApps(releaseDir);
if (apps.length === 0) violations.push(`no .app bundle found under ${releaseDir}`);

const unsafePrivacyKeys = [
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
];
const requiredNotices = [
  "LICENSE.txt",
  "LICENSING.md",
  "PRIVACY.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
];
const FUSE_DISABLED = "0".charCodeAt(0);
const FUSE_ENABLED = "1".charCodeAt(0);
const requiredFuses = new Map([
  [FuseV1Options.RunAsNode, FUSE_DISABLED],
  // The persistent, isolated Amazon session must never write plaintext cookie
  // values into its Chromium profile.
  [FuseV1Options.EnableCookieEncryption, FUSE_ENABLED],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FUSE_DISABLED],
  [FuseV1Options.EnableNodeCliInspectArguments, FUSE_DISABLED],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FUSE_ENABLED],
  [FuseV1Options.OnlyLoadAppFromAsar, FUSE_ENABLED],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FUSE_DISABLED],
]);

for (const app of apps) {
  const infoPath = join(app, "Contents", "Info.plist");
  const info = plist.parse(readFileSync(infoPath, "utf8"));
  if (info.CFBundleIdentifier !== "com.dmytroklymenko.balance") {
    violations.push(`${relative(releaseDir, infoPath)}: unexpected bundle identifier`);
  }
  if (info.CFBundleIconFile === "electron.icns") {
    violations.push(`${relative(releaseDir, infoPath)}: generic Electron icon`);
  }
  const helperPath = join(app, "Contents", "Frameworks", `${info.CFBundleName} Helper.app`);
  if (!existsSync(helperPath)) {
    violations.push(`${relative(releaseDir, infoPath)}: CFBundleName does not match packaged helper apps`);
  }
  if (info.NSAppTransportSecurity?.NSAllowsArbitraryLoads !== false) {
    violations.push(`${relative(releaseDir, infoPath)}: unrestricted network transport`);
  }
  for (const key of unsafePrivacyKeys) {
    if (key in info) violations.push(`${relative(releaseDir, infoPath)}: unused ${key}`);
  }
  for (const notice of requiredNotices) {
    const noticePath = join(app, "Contents", "Resources", notice);
    if (!existsSync(noticePath) || statSync(noticePath).size === 0) {
      violations.push(`${relative(releaseDir, app)}: missing ${notice}`);
    }
  }
  const fuseWire = await getCurrentFuseWire(app);
  for (const [fuse, expected] of requiredFuses) {
    if (fuseWire[fuse] !== expected) {
      violations.push(`${relative(releaseDir, app)}: unsafe Electron fuse ${FuseV1Options[fuse]}`);
    }
  }
}

const instructionNames = new Set([
  ".cursorrules",
  "agents.md",
  "ai_instructions.md",
  "balance.md",
  "built.md",
  "claude.md",
  "codex.md",
  "copilot-instructions.md",
  "gemini.md",
  "instructions.md",
]);

function firstPartyViolation(entry) {
  const normalized = entry.replaceAll("\\", "/");
  const fileName = normalized.split("/").at(-1);
  if (fileName && instructionNames.has(fileName.toLowerCase())) return "internal instruction file";

  const packages = [
    ["/node_modules/@balance/server/", ["dist/", "client-dist/", "src/migrations/", "package.json"]],
    ["/node_modules/@balance/core/", ["dist/", "package.json"]],
    ["/node_modules/@balance/sync-client/", ["dist/", "package.json"]],
  ];
  for (const [prefix, allowed] of packages) {
    if (!normalized.startsWith(prefix)) continue;
    const rest = normalized.slice(prefix.length);
    const isAllowed = allowed.some((path) =>
      rest === path || rest.startsWith(path) || path.startsWith(`${rest}/`),
    );
    if (!isAllowed) {
      return `unexpected first-party package content (${rest})`;
    }
  }
  return null;
}

for (const asar of asars) {
  for (const entry of listPackage(asar)) {
    const reason = firstPartyViolation(entry);
    if (reason) violations.push(`${relative(releaseDir, asar)}:${entry}: ${reason}`);
  }
}

if (violations.length > 0) {
  throw new Error(`Unsafe package contents:\n${violations.slice(0, 50).join("\n")}`);
}

console.log(
  `Verified ${asars.length} package and ${apps.length} application bundle: no local data, internal instructions, generic icon, missing notices, unsafe Electron fuses, or unsafe macOS permissions.`,
);
