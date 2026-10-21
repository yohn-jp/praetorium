import { describe, expect, it } from "vitest";
import { isSafeRelativeRedirect } from "../src/redirect-allowlist.js";

describe("same-origin relative redirects", () => {
  it("accepts ordinary paths and encoded query values", () => {
    expect(isSafeRelativeRedirect("/")).toBe(true);
    expect(isSafeRelativeRedirect("/repositories/482901?tab=permissions#settings")).toBe(true);
    expect(isSafeRelativeRedirect("/search?q=hello%20world")).toBe(true);
  });

  it.each([
    "",
    "relative/path",
    "//attacker.example/path",
    "///attacker.example/path",
    "/\\attacker.example/path",
    "/\t//attacker.example/path",
    "/\r\n//attacker.example/path",
    "/path\u0000suffix",
    "/%09//attacker.example/path",
    "/%5c%5cattacker.example/path",
    "https://attacker.example/path",
    "https://redirect.invalid/path",
  ])("rejects normalized or off-origin target %j", (target) => {
    expect(isSafeRelativeRedirect(target)).toBe(false);
  });
});
