import { describe, expect, it } from "vitest";
import { resolveTokenVault } from "../src/adapters/token-vault.js";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

describe("Gateway token encryption key lifecycle", () => {
  it("reuses only the vault for the same key ID and exact secret", async () => {
    const firstSecret = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const first = await resolveTokenVault("token-key-one", firstSecret);
    expect(await resolveTokenVault("token-key-one", firstSecret)).toBe(first);

    const changedId = await resolveTokenVault("token-key-two", firstSecret);
    expect(changedId).not.toBe(first);

    const rotatedSecret = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const rotated = await resolveTokenVault("token-key-two", rotatedSecret);
    expect(rotated).not.toBe(changedId);
  });

  it("rejects malformed or incorrectly sized key material", () => {
    expect(() => resolveTokenVault("token-key-invalid", "not base64url")).toThrow(
      "token encryption key must be base64url",
    );
    expect(() => resolveTokenVault("token-key-invalid", base64Url(new Uint8Array(31)))).toThrow(
      "GATEWAY_TOKEN_ENCRYPTION_KEY must decode to 32 bytes",
    );
  });
});
