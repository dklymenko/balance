import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chooserHtml = readFileSync(
  resolve(__dirname, "..", "chooser.html"),
  "utf8",
);

describe("first-run chooser", () => {
  it("uses a clear privacy promise without database jargon", () => {
    expect(chooserHtml).toContain("Your money. Right where it belongs.");
    expect(chooserHtml).toContain(
      "Your data runs fully locally and never leaves your computer.",
    );
    expect(chooserHtml).not.toMatch(/sqlite/i);
  });

  it("presents cloud as unavailable when its availability check fails", () => {
    expect(chooserHtml).toContain("const markCloudUnavailable = () =>");
    expect(chooserHtml).toContain(".catch(markCloudUnavailable)");
    expect(chooserHtml).toContain("cloud-badge\").hidden = false");
    expect(chooserHtml).toContain("Not open to the public yet.");
  });
});
