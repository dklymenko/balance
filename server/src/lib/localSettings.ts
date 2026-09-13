// Local, per-machine settings that should never be committed to git.
// Stored at server/data/local-settings.json (the data/ dir is gitignored).
//
// Tests can pass a stub via createApp(..., undefined, undefined, settings).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface LocalSettings {
  // Account that Amazon-matched rows should be reassigned to. Lets the user
  // import an Amazon-laden CSV against any default account, click "Match
  // Amazon Orders", and have the matched rows land on the right card.
  amazonDefaultAccountId: number | null;
}

const SETTINGS_PATH = resolve(process.cwd(), "data/local-settings.json");

export function readLocalSettings(): LocalSettings {
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalSettings>;
    return {
      amazonDefaultAccountId:
        typeof parsed.amazonDefaultAccountId === "number" ? parsed.amazonDefaultAccountId : null,
    };
  } catch {
    return { amazonDefaultAccountId: null };
  }
}
