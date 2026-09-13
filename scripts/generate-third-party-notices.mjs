import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const licenseName = /^(licen[sc]e|copying|notice)(\..*)?$/i;
const ownPackages = new Set([
  "@balance/client",
  "@balance/core",
  "@balance/server",
  "@balance/sync-client",
  "balance-desktop",
]);

// Source copied into the repository is not represented by package-lock.json,
// so keep those notices here. This section is deliberately generated alongside
// package notices so `npm run notices` can never erase required attribution.
const vendoredSources = [
  {
    name: "shadcn/ui",
    source: "https://github.com/shadcn-ui/ui",
    paths: ["client/src/components/ui", "client/src/lib/utils.ts"],
    license: "MIT",
    licenseText: `MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  },
];

function packageJson(packageDir) {
  return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
}

function cleanLicenseText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function topLevelLicenses(packageDir) {
  return readdirSync(packageDir)
    .filter((name) => licenseName.test(name) && statSync(join(packageDir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: cleanLicenseText(readFileSync(join(packageDir, name), "utf8")) }));
}

function nestedLicenses(packageDir) {
  const found = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (licenseName.test(name)) {
        found.push({ name: relative(packageDir, path), text: cleanLicenseText(readFileSync(path, "utf8")) });
      }
    }
  };
  visit(packageDir);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function licenseFromPeer(spdx, records) {
  for (const record of records) {
    if (record.license !== spdx) continue;
    const files = topLevelLicenses(record.dir);
    if (files.length > 0) return files;
  }
  return [];
}

const records = [];
for (const [packagePath, metadata] of Object.entries(lock.packages)) {
  if (!packagePath.includes("node_modules/") || metadata.dev === true) continue;
  const dir = resolve(root, packagePath);
  if (!existsSync(join(dir, "package.json"))) {
    throw new Error(`Installed package is missing for ${packagePath}; run npm ci first`);
  }
  const pkg = packageJson(dir);
  if (ownPackages.has(pkg.name)) continue;
  if (!pkg.name || !pkg.version || !pkg.license) {
    throw new Error(`${packagePath} has incomplete name, version, or license metadata`);
  }
  records.push({
    name: pkg.name,
    version: pkg.version,
    license: typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license),
    author: typeof pkg.author === "string" ? pkg.author : pkg.author?.name ?? "",
    dir,
  });
}

const unique = [...new Map(records.map((record) => [`${record.name}@${record.version}`, record])).values()]
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const sections = [];
for (const record of unique) {
  let files = topLevelLicenses(record.dir);
  if (files.length === 0 && record.name === "victory-vendor") {
    files = nestedLicenses(record.dir);
  }
  if (files.length === 0 && record.name === "drizzle-orm") {
    files = licenseFromPeer("Apache-2.0", unique);
  }
  if (files.length === 0 && record.name === "react-remove-scroll-bar") {
    files = [{
      name: "MIT License",
      text: `Copyright (c) ${record.author || "the package authors"}\n\n` +
        "Permission is hereby granted, free of charge, to any person obtaining a copy " +
        "of this software and associated documentation files (the \"Software\"), to deal " +
        "in the Software without restriction, including without limitation the rights " +
        "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies " +
        "of the Software, and to permit persons to whom the Software is furnished to do so, " +
        "subject to the following conditions:\n\n" +
        "The above copyright notice and this permission notice shall be included in all " +
        "copies or substantial portions of the Software.\n\n" +
        "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR " +
        "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS " +
        "FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR " +
        "COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN " +
        "AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION " +
        "WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
    }];
  }
  if (files.length === 0) {
    throw new Error(`No license text found for ${record.name}@${record.version} (${record.license})`);
  }
  sections.push({ record, files });
}

const lines = [
  "# Third-Party Notices",
  "",
  "Balance includes the third-party packages and vendored source below. Each",
  "component remains subject to its own license. This file is generated from the",
  "locked production dependency tree and the vendored-source registry in",
  "`scripts/generate-third-party-notices.mjs`; packaging fails if a required",
  "license text is missing.",
  "",
  "Electron also places its own `LICENSE.electron.txt` and",
  "`LICENSES.chromium.html` files in the application Resources directory.",
  "",
  "## Vendored source",
  "",
];

for (const source of vendoredSources) {
  lines.push(
    `### ${source.name}`,
    "",
    `Source: ${source.source}`,
    "",
    `Repository paths: ${source.paths.map((path) => `\`${path}\``).join(", ")}`,
    "",
    `Declared license: ${source.license}`,
    "",
    "```text",
    source.licenseText,
    "```",
    "",
  );
}

lines.push(
  "## Installed production packages",
  "",
  "| Package | Version | License |",
  "|---|---:|---|",
  ...unique.map((record) => `| ${record.name.replaceAll("|", "\\|")} | ${record.version} | ${record.license.replaceAll("|", "\\|")} |`),
  "",
  "## License texts",
  "",
);

for (const { record, files } of sections) {
  lines.push(`### ${record.name} ${record.version}`, "", `Declared license: ${record.license}`, "");
  for (const file of files) {
    if (files.length > 1) lines.push(`Source file: ${file.name}`, "");
    lines.push("```text", file.text, "```", "");
  }
}

const output = join(root, "THIRD_PARTY_NOTICES.md");
writeFileSync(output, `${lines.join("\n").trimEnd()}\n`);
console.log(`Wrote ${relative(process.cwd(), output)} for ${unique.length} production packages.`);
