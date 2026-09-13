#!/usr/bin/env node
// Native SQLite drivers are built for two different runtimes, and getting that
// wrong leaves the app unable to open its ledger. This script builds the split
// and then proves it.
//
//   better-sqlite3                       Node    server tests and the dev server
//   better-sqlite3-multiple-ciphers      Electron the encrypted ledger in the app
//   better-sqlite3-multiple-ciphers-node Node    desktop encryption tests
//
// The middle one is the trap. A normal install leaves it compiled for Node,
// while electron-builder may rebuild hoisted native modules for Electron and
// leave the development workspace in that state after packaging. The result
// can either pass tests and fail in the app, or package successfully and make
// the next Node test run fail with ERR_DLOPEN_FAILED.
//
// So `build` first repairs any Node driver that no longer opens under Node,
// then builds the encrypted driver explicitly for Electron. `check` asserts
// the split afterwards so neither failure can reach a user.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));

const ELECTRON_DRIVER = "better-sqlite3-multiple-ciphers";
const NODE_DRIVERS = ["better-sqlite3", "better-sqlite3-multiple-ciphers-node"];

function electronVersion() {
  const pkg = JSON.parse(readFileSync(join(root, "desktop", "package.json"), "utf8"));
  const spec = pkg.devDependencies?.electron;
  if (!spec) throw new Error("desktop/package.json does not declare electron");
  // The version is pinned exactly so electron-builder can resolve it; a range
  // would leave the build target ambiguous.
  if (!/^\d+\.\d+\.\d+$/.test(spec)) {
    throw new Error(`electron must be pinned to an exact version, found "${spec}"`);
  }
  return spec;
}

// Loading the module only evaluates its JavaScript wrapper. The native binding
// is opened lazily by the constructor, so an ABI mismatch surfaces there and
// nowhere earlier. Construct to find out.
function opensUnderNode(name) {
  try {
    const Database = require(name);
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
}

function moduleDir(name) {
  const dir = join(root, "node_modules", name);
  if (!existsSync(dir)) throw new Error(`${name} is not installed; run npm ci first`);
  return dir;
}

function rebuildNodeDrivers(nodeGyp) {
  for (const name of NODE_DRIVERS) {
    if (opensUnderNode(name)) continue;
    process.stdout.write(`Rebuilding ${name} for Node ${process.versions.node} (${process.arch})\n`);
    execFileSync(
      process.execPath,
      [nodeGyp, "rebuild", `--arch=${process.arch}`],
      { cwd: moduleDir(name), stdio: ["ignore", "ignore", "inherit"] },
    );
  }
}

function build() {
  const target = electronVersion();
  const dir = moduleDir(ELECTRON_DRIVER);
  const nodeGyp = join(root, "node_modules", "node-gyp", "bin", "node-gyp.js");
  if (!existsSync(nodeGyp)) throw new Error("node-gyp is not installed; run npm ci first");

  rebuildNodeDrivers(nodeGyp);
  process.stdout.write(`Building ${ELECTRON_DRIVER} for Electron ${target} (${process.arch})\n`);
  execFileSync(
    process.execPath,
    [
      nodeGyp, "rebuild",
      `--target=${target}`,
      `--arch=${process.arch}`,
      "--runtime=electron",
      "--dist-url=https://electronjs.org/headers",
    ],
    { cwd: dir, stdio: ["ignore", "ignore", "inherit"] },
  );
}

function check() {
  const problems = [];

  for (const name of NODE_DRIVERS) {
    if (!opensUnderNode(name)) {
      problems.push(`${name} must be built for Node but does not open under Node.`);
    }
  }

  // A driver built for Electron cannot open under Node. That failure is the
  // evidence, so opening successfully here is what indicates the bug.
  if (opensUnderNode(ELECTRON_DRIVER)) {
    problems.push(
      `${ELECTRON_DRIVER} must be built for Electron but opens under Node, ` +
      "which means the app would fail to open its database at startup.",
    );
  }

  if (problems.length) {
    process.stderr.write("Native driver ABI check failed:\n");
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.stderr.write("\nRun: npm run abi\n");
    process.exit(1);
  }
  process.stdout.write("Native driver ABI split verified (Node and Electron).\n");
}

const mode = process.argv[2] ?? "build";
if (mode === "build") {
  build();
  check();
} else if (mode === "check") {
  check();
} else {
  process.stderr.write(`Unknown mode "${mode}". Use build or check.\n`);
  process.exit(1);
}
