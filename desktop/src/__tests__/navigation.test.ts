import { describe, expect, it } from "vitest";
import {
  desktopAuthCode,
  externalHttpsUrl,
  isAllowedShellNavigation,
  isAmazonNavigation,
  loadUrlWithRetry,
} from "../navigation";

describe("externalHttpsUrl", () => {
  it("allows only well-formed HTTPS links", () => {
    expect(externalHttpsUrl("https://example.com/help?q=1")).toBe("https://example.com/help?q=1");
    expect(externalHttpsUrl("http://example.com")).toBeNull();
    expect(externalHttpsUrl("file:///etc/passwd")).toBeNull();
    expect(externalHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(externalHttpsUrl("https://trusted.example@attacker.example/help")).toBeNull();
    expect(externalHttpsUrl("balance-desktop://auth?code=x")).toBeNull();
    expect(externalHttpsUrl("not a url")).toBeNull();
  });
});

describe("isAmazonNavigation", () => {
  it("allows only HTTPS Amazon hosts", () => {
    expect(isAmazonNavigation("https://www.amazon.com/ap/signin")).toBe(true);
    expect(isAmazonNavigation("https://amazon.com/your-orders/orders")).toBe(true);
    expect(isAmazonNavigation("http://www.amazon.com/ap/signin")).toBe(false);
    expect(isAmazonNavigation("https://someone@amazon.com/your-orders/orders")).toBe(false);
    expect(isAmazonNavigation("https://amazon.com.evil.example/signin")).toBe(false);
    expect(isAmazonNavigation("https://example.com/?next=amazon.com")).toBe(false);
  });
});

describe("desktopAuthCode", () => {
  it("accepts only the exact private callback authority", () => {
    expect(desktopAuthCode("balance-desktop://auth/#code=one%2Ftwo")).toBe("one/two");
    expect(desktopAuthCode("balance-desktop://auth.evil.example/#code=stolen")).toBeNull();
    expect(desktopAuthCode("balance-desktop://auth@evil.example/#code=stolen")).toBeNull();
    expect(desktopAuthCode("balance-desktop://auth/other#code=stolen")).toBeNull();
    expect(desktopAuthCode("balance-desktop://auth/#code=")).toBeNull();
  });
});

describe("isAllowedShellNavigation", () => {
  const appOrigin = "http://127.0.0.1:43210";
  const syncOrigin = "https://cloud.balance.example";

  it("keeps normal app navigation on its exact origin", () => {
    expect(isAllowedShellNavigation(`${appOrigin}/transactions`, appOrigin, syncOrigin, false)).toBe(true);
    expect(isAllowedShellNavigation("http://localhost:43210/transactions", appOrigin, syncOrigin, false)).toBe(false);
    expect(isAllowedShellNavigation("http://user@127.0.0.1:43210/transactions", appOrigin, syncOrigin, false)).toBe(false);
  });

  it("limits cloud sign-in to the configured service and Google's account host", () => {
    expect(isAllowedShellNavigation(`${syncOrigin}/auth/google`, appOrigin, syncOrigin, true)).toBe(true);
    expect(isAllowedShellNavigation("https://accounts.google.com/o/oauth2/v2/auth", appOrigin, syncOrigin, true)).toBe(true);
    expect(isAllowedShellNavigation("https://mail.google.com/", appOrigin, syncOrigin, true)).toBe(false);
    expect(isAllowedShellNavigation("https://accounts.google.com.evil.example/", appOrigin, syncOrigin, true)).toBe(false);
    expect(isAllowedShellNavigation(`https://user@cloud.balance.example/auth`, appOrigin, syncOrigin, true)).toBe(false);
  });
});

describe("loadUrlWithRetry", () => {
  it("recovers a transient first navigation failure", async () => {
    let calls = 0;
    await loadUrlWithRetry(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ERR_ABORTED");
    }, 0);
    expect(calls).toBe(2);
  });

  it("surfaces a persistent navigation failure after one retry", async () => {
    let calls = 0;
    await expect(loadUrlWithRetry(async () => {
      calls += 1;
      throw new Error("still broken");
    }, 0)).rejects.toThrow("still broken");
    expect(calls).toBe(2);
  });
});
