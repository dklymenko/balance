import { describe, expect, it } from "vitest";
import { shouldRestoreMainWindow } from "../windowLifecycle";

describe("main-window restoration after App Lock", () => {
  it("restores the app whenever its main window is absent or destroyed", () => {
    expect(shouldRestoreMainWindow(null)).toBe(true);
    expect(shouldRestoreMainWindow({ isDestroyed: () => true })).toBe(true);
    expect(shouldRestoreMainWindow({ isDestroyed: () => false })).toBe(false);
  });
});
