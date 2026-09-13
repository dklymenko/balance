import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicationPathViolation } from "./release-hygiene-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const author = "Dmytro Klymenko";
const license = "PolyForm-Noncommercial-1.0.0";
const manifestPaths = [
  "package.json",
  "client/package.json",
  "server/package.json",
  "desktop/package.json",
  "packages/core/package.json",
  "packages/sync-client/package.json",
];
const workspacePaths = new Set(["client", "server", "desktop", "packages/core", "packages/sync-client"]);
const externalDependency = /^(?:git(?:\+[^:]+)?:|github:|https?:|file:|link:|\/)/i;
// Keep the gate's own source free of the product names it rejects.
const competitorNames = [
  ["Y", "NAB"],
  ["Mon", "arch(?: Money)?"],
  ["Quick", "en"],
  ["Rocket", " Money"],
  ["Copilot", " Money"],
  ["Simpli", "fi"],
  ["Empower", " Personal Dashboard"],
].map((parts) => parts.join(""));
const competitorProduct = new RegExp(`\\b(?:${competitorNames.join("|")})\\b`, "i");
const mintProduct = new RegExp("\\bM" + "int(?:\\.com)?\\b");
const searchableText = /\.(?:css|html|js|json|jsx|md|mjs|sql|ts|tsx|txt|ya?ml)$/i;
const violations = [];

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
// Include non-ignored, untracked files and omit staged paths that no longer
// exist. This models the tree a maintainer will publish after `git add -A`,
// including before an initial commit exists.
const publishable = git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
  .split("\0")
  .filter((path) => path && existsSync(join(root, path)));

for (const path of publishable) {
  const pathViolation = publicationPathViolation(path);
  if (pathViolation) violations.push(`${path}: ${pathViolation}; file must not be published`);
  if (searchableText.test(path)) {
    const contents = readFileSync(join(root, path), "utf8");
    if (competitorProduct.test(contents) || mintProduct.test(contents)) {
      violations.push(`${path}: competitor product reference is not allowed`);
    }
  }
}

for (const line of git("ls-files", "--stage").split("\n")) {
  if (line.startsWith("160000 ")) violations.push(`${line.split("\t")[1]}: gitlink dependency is not allowed`);
}
if (publishable.includes(".gitmodules")) violations.push(".gitmodules: submodules are not allowed");

for (const manifestPath of manifestPaths) {
  const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
  if (manifest.author !== author) violations.push(`${manifestPath}: author must be ${author}`);
  if (manifest.license !== license) violations.push(`${manifestPath}: unexpected license metadata`);
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (typeof spec === "string" && externalDependency.test(spec)) {
        violations.push(`${manifestPath}: ${section}.${name} uses external source ${spec}`);
      }
    }
  }
}

const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  const resolved = metadata.resolved;
  if (typeof resolved !== "string") continue;
  if (metadata.link === true && workspacePaths.has(resolved)) continue;
  try {
    if (new URL(resolved).hostname !== "registry.npmjs.org") {
      violations.push(`${packagePath}: lockfile resolves outside registry.npmjs.org`);
    }
  } catch {
    violations.push(`${packagePath}: lockfile has an invalid resolved URL`);
  }
}

if (!readFileSync(join(root, "LICENSE"), "utf8").includes(author)) {
  violations.push(`LICENSE: missing ${author} copyright notice`);
}

if (violations.length > 0) {
  throw new Error(`Release hygiene check failed:\n${violations.join("\n")}`);
}

console.log(`Verified ${publishable.length} publishable paths and ${manifestPaths.length} first-party manifests.`);
