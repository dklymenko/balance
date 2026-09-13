import assert from "node:assert/strict";
import test from "node:test";
import { publicationPathViolation } from "./release-hygiene-policy.mjs";

test("rejects internal documents and tool instructions", () => {
  const internalPaths = [
    "Built.md",
    "Claude.md",
    "PRD.md",
    "docs/PRODUCT-REQUIREMENTS.md",
    "docs/NEXT-SESSION-ROADMAP.md",
    "planning/launch-plan.md",
    "notes/engineering-strategy.txt",
    "handoff.yaml",
    ".agents/rules.md",
    ".gemini/settings.json",
    "internal/random.bin",
    "docs/launch-brief.pdf",
    "planning/PRD.csv",
    ".github/copilot-instructions.md",
  ];

  for (const path of internalPaths) {
    assert.ok(publicationPathViolation(path), `${path} should be rejected`);
  }
});

test("allows only explicitly reviewed public Markdown", () => {
  const publicPaths = [
    "README.md",
    "INSTALL.md",
    "LICENSING.md",
    "PRIVACY.md",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "packages/sync-client/README.md",
  ];

  for (const path of publicPaths) {
    assert.equal(publicationPathViolation(path), null, `${path} should be allowed`);
  }
  assert.ok(publicationPathViolation("docs/innocent-looking-name.md"));
});

test("allows normal source and repository files", () => {
  for (const path of ["client/src/App.tsx", "package.json", ".github/workflows/ci.yml"]) {
    assert.equal(publicationPathViolation(path), null, `${path} should be allowed`);
  }
});
