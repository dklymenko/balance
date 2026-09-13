import { basename } from "node:path";

const publicMarkdown = new Set([
  "README.md",
  "INSTALL.md",
  "LICENSING.md",
  "PRIVACY.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "packages/sync-client/README.md",
]);

const internalToolPath = /(?:^|\/)\.(?:agents|aider|claude|codex|continue|cursor|gemini|roo|windsurf)(?:\/|$)/i;
const internalWorkingDirectory = /(?:^|\/)(?:handoff|internal|notes|planning|plans|roadmap)(?:\/|$)/i;
const internalDocumentExtension = /\.(?:adoc|csv|json|md|org|rst|txt|ya?ml)$/i;
const unreviewedDocumentArtifact = /\.(?:docx?|key|numbers|pages|pdf|pptx?|xlsx?)$/i;
const internalDocumentToken = /(?:^|[-_.])(?:audit|backlog|built|context|decisions?|design|handoff|instructions?|memory|notes?|plans?|planning|prd|prompts?|requirements?|research|roadmap|rules?|sessions?|spec|status|strategy|tasks?|todo)(?:[-_.]|$)/i;

export function publicationPathViolation(rawPath) {
  const path = rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
  const name = basename(path);

  if (internalToolPath.test(path) || name.toLowerCase() === ".cursorrules") {
    return "internal tool configuration";
  }
  if (internalWorkingDirectory.test(path)) {
    return "internal working directory";
  }
  if (path.toLowerCase() === ".github/copilot-instructions.md") {
    return "internal tool instruction file";
  }
  if (path.toLowerCase().endsWith(".md") && !publicMarkdown.has(path)) {
    return "Markdown document is not on the reviewed public-document allowlist";
  }
  if (internalDocumentExtension.test(name) && internalDocumentToken.test(name)) {
    return "internal planning, instruction, or working document";
  }
  if (unreviewedDocumentArtifact.test(name)) {
    return "unreviewed document artifact";
  }
  return null;
}
