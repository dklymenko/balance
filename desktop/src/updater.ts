// Informational source-release checker. Updating is intentionally left to the
// repository owner: Balance never modifies a checkout or executes package
// installation commands on the user's behalf.

export const UPDATE_REPO = "dklymenko/balance";

export interface ReleaseInfo {
  tag: string;
  notes: string;
  url: string;
}

export interface UpdateCheck {
  current: string;
  latest: ReleaseInfo | null;
  updateAvailable: boolean;
}

// Tagged versions use vMAJOR.MINOR.PATCH to match the application version.
// Anything else is ignored rather than guessed at.
export function parseVersion(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewer(latest: string, current: string): boolean {
  const candidate = parseVersion(latest);
  const installed = parseVersion(current);
  if (!candidate || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index] > installed[index]) return true;
    if (candidate[index] < installed[index]) return false;
  }
  return false;
}

export function parseLatestRelease(payload: unknown): ReleaseInfo | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { tag_name: tag, body, draft, prerelease } = payload as Record<string, unknown>;
  if (draft === true || prerelease === true) return null;
  if (typeof tag !== "string" || !parseVersion(tag)) return null;
  return {
    tag,
    notes: typeof body === "string" ? body : "",
    url: `https://github.com/${UPDATE_REPO}/releases/tag/${encodeURIComponent(tag)}`,
  };
}

export async function fetchLatestRelease(
  repo = UPDATE_REPO,
  timeoutMs = 8000,
): Promise<ReleaseInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseLatestRelease(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdate(current: string, repo = UPDATE_REPO): Promise<UpdateCheck> {
  const latest = await fetchLatestRelease(repo);
  return {
    current,
    latest,
    updateAvailable: latest !== null && isNewer(latest.tag, current),
  };
}
