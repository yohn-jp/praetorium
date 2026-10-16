import { describe, expect, it } from "vitest";
import {
  exportPublicKeyJwk,
  exportPrivateKeyJwk,
  generateSigningKeyPair,
} from "../src/keys/crypto.js";
import {
  addNextKey,
  buildJwksDocument,
  promoteNextKey,
  resolveVerificationKey,
  type KeyRecord,
} from "../src/keys/registry.js";

describe("verification key publication", () => {
  it("publishes only the ES256 public members and excludes compromised keys", async () => {
    const pair = await generateSigningKeyPair();
    const publicKeyJwk = await exportPublicKeyJwk(pair.publicKey);
    const privateKeyJwk = await exportPrivateKeyJwk(pair.privateKey);
    const added = addNextKey([], {
      kid: "key-next",
      publicKeyJwk,
      createdAt: "2026-10-17T00:00:00.000Z",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const promoted = promoteNextKey(added.value, "2026-10-17T00:00:00.000Z");
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    const document = buildJwksDocument(promoted.value);
    expect(document.keys).toHaveLength(1);
    expect(Object.keys(document.keys[0] ?? {}).sort()).toEqual([
      "alg",
      "crv",
      "kid",
      "kty",
      "use",
      "x",
      "y",
    ]);
    expect(JSON.stringify(document)).not.toContain(privateKeyJwk.d);
  });

  it("rejects private JWK material on add and refuses malformed persisted keys", async () => {
    const pair = await generateSigningKeyPair();
    const publicKeyJwk = await exportPublicKeyJwk(pair.publicKey);
    const privateKeyJwk = await exportPrivateKeyJwk(pair.privateKey);
    expect(
      addNextKey([], {
        kid: "bad-key",
        publicKeyJwk: privateKeyJwk,
        createdAt: "2026-10-17T00:00:00.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PUBLIC_KEY" } });

    const polluted: KeyRecord = {
      kid: "polluted-key",
      status: "active",
      publicKeyJwk: { ...publicKeyJwk, d: privateKeyJwk.d },
      createdAt: "2026-10-17T00:00:00.000Z",
      retiredAt: null,
    };
    expect(() => buildJwksDocument([polluted])).toThrow("invalid public key material");
    expect(await resolveVerificationKey([polluted], polluted.kid)).toBeNull();
  });
});
