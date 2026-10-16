import { describe, expect, it } from "vitest";
import { createTokenVault, importTokenEncryptionKey } from "../src/token-vault.js";

describe("encrypted GitHub user token storage", () => {
  it("authenticates row context and supports key rotation without exposing plaintext", async () => {
    const oldKey = { id: "old", key: await importTokenEncryptionKey(new Uint8Array(32).fill(1)) };
    const newKey = { id: "new", key: await importTokenEncryptionKey(new Uint8Array(32).fill(2)) };
    const oldVault = createTokenVault([oldKey], "old");
    const secret = await oldVault.seal("access-token|refresh-token", "github-user:4242");

    expect(secret.keyId).toBe("old");
    expect(JSON.stringify(secret)).not.toContain("access-token");
    expect(await createTokenVault([oldKey, newKey], "new").open(secret, "github-user:4242")).toBe(
      "access-token|refresh-token",
    );
    await expect(oldVault.open(secret, "github-user:other")).rejects.toThrow();
    const newlySealed = await createTokenVault([oldKey, newKey], "new").seal(
      "rotated",
      "github-user:4242",
    );
    expect(newlySealed.keyId).toBe("new");
  });
});
