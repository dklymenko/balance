import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("generated notices permanently include vendored shadcn source", () => {
  execFileSync(process.execPath, [join(root, "scripts/generate-third-party-notices.mjs")], {
    cwd: root,
    stdio: "pipe",
  });
  const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(notices, /## Vendored source/);
  assert.match(notices, /### shadcn\/ui/);
  assert.match(notices, /Copyright \(c\) 2023 shadcn/);
  assert.match(notices, /client\/src\/components\/ui/);
  assert.match(notices, /client\/src\/lib\/utils\.ts/);
});
