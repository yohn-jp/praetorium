import { describe, expect, it } from "vitest";
import { createKvDigestUserIndex } from "../src/adapters/digest-user-index.js";
import type { UserId } from "@praetorium/auth";

describe("KV digest routing index", () => {
  it("expires entries at the authoritative record expiry and supports stale-entry cleanup", async () => {
    const entries = new Map<string, string>();
    const puts: Array<{ key: string; expiration?: number }> = [];
    const deletes: string[] = [];
    const kv = {
      async put(key: string, value: string, options?: { expiration?: number }) {
        entries.set(key, value);
        puts.push({ key, expiration: options?.expiration });
      },
      async get(key: string) { return entries.get(key) ?? null; },
      async delete(key: string) { entries.delete(key); deletes.push(key); },
    } as unknown as KVNamespace;
    const index = createKvDigestUserIndex(kv, "session");
    const expiry = "2099-01-01T00:00:00.000Z";

    await index.set("digest-a", "213253858" as UserId, expiry);

    expect(puts).toEqual([{
      key: "praetorium:digest-user:session:digest-a",
      expiration: Math.ceil(Date.parse(expiry) / 1000),
    }]);
    await expect(index.get("digest-a")).resolves.toBe("213253858");
    await index.delete("digest-a");
    expect(deletes).toEqual(["praetorium:digest-user:session:digest-a"]);
    await expect(index.get("digest-a")).resolves.toBeNull();
  });
});
