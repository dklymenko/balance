import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { errorStatus, sendError } from "../../lib/validation.js";

function responseDouble() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { response: { status } as unknown as Response, status, json };
}

describe("safe route errors", () => {
  it("accepts only the expected caller-fixable statuses", () => {
    expect(errorStatus(Object.assign(new Error("bad request"), { status: 400 }))).toBe(400);
    expect(errorStatus(Object.assign(new Error("not found"), { status: 404 }))).toBe(404);
    expect(errorStatus(Object.assign(new Error("conflict"), { status: 409 }))).toBe(409);
    expect(errorStatus(Object.assign(new Error("internal detail"), { status: 500 }))).toBeNull();
    expect(errorStatus(Object.assign(new Error("redirect"), { status: 302 }))).toBeNull();
    expect(errorStatus(Object.assign(new Error("fractional"), { status: 400.5 }))).toBeNull();
  });

  it("does not expose an internal message merely because an error has a status field", () => {
    const { response, status, json } = responseDouble();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      sendError(response, Object.assign(new Error("database path and key"), { status: 500 }), "Operation failed");
      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: "Operation failed" });
      expect(consoleError).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });
});
