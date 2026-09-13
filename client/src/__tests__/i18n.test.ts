import { describe, it, expect } from "vitest";
import { translate, LANGS } from "@/lib/i18n";

describe("i18n", () => {
  it("offers exactly the four supported languages", () => {
    expect(LANGS.map((l) => l.code)).toEqual(["en", "uk", "es", "de"]);
  });

  it("translates a known key across all languages", () => {
    expect(translate("en", "nav.accounts")).toBe("Accounts");
    expect(translate("uk", "nav.accounts")).toBe("Рахунки");
    expect(translate("es", "nav.accounts")).toBe("Cuentas");
    expect(translate("de", "nav.accounts")).toBe("Konten");
  });

  it("keeps English values byte-identical to the original UI strings", () => {
    // Guards the invariant that lets the rest of the suite run in `en`.
    expect(translate("en", "tx.searchPlaceholder")).toBe("Search by amount, category or comment...");
    expect(translate("en", "signin.google")).toBe("Sign in with Google");
  });

  it("describes the current translation coverage honestly", () => {
    for (const lang of LANGS.map((entry) => entry.code)) {
      expect(translate(lang, "settings.languageHint")).toMatch(/advanced|розширені|avanzadas|erweiterte/i);
    }
  });

  it("falls back to the raw key for an unknown key", () => {
    expect(translate("de", "does.not.exist")).toBe("does.not.exist");
  });
});
