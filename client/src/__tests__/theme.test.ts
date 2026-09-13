import { describe, it, expect, beforeEach } from "vitest";
import { getStoredTheme, setTheme, applyTheme } from "@/lib/theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("theme helper", () => {
  it("defaults to 'system' when nothing is stored", () => {
    expect(getStoredTheme()).toBe("system");
  });

  it("setTheme('dark') persists the choice and sets data-theme", () => {
    setTheme("dark");
    expect(localStorage.getItem("balance-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(getStoredTheme()).toBe("dark");
  });

  it("setTheme('system') clears storage and removes the attribute", () => {
    setTheme("dark");
    setTheme("system");
    expect(localStorage.getItem("balance-theme")).toBeNull();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(getStoredTheme()).toBe("system");
  });

  it("applyTheme('light') sets the attribute without touching storage", () => {
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("balance-theme")).toBeNull();
  });
});
