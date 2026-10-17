import { describe, expect, it } from "vitest";
import type { KeyRecord } from "@praetorium/auth";
import { assertActiveSigningKeyRegistered, resolveActiveSigningKey } from "../src/adapters/signing-key.js";

async function generatedKey(kid: string): Promise<{
  readonly secret: string;
  readonly jwk: JsonWebKey;
  readonly record: KeyRecord;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!jwk.x || !jwk.y) throw new Error("generated signing key is missing its public coordinates");
  return {
    secret: JSON.stringify({ kid, privateKeyJwk: jwk }),
    jwk,
    record: {
      kid,
      status: "active",
      publicKeyJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
      createdAt: "2026-10-18T00:00:00.000Z",
      retiredAt: null,
    },
  };
}

describe("Gateway signing key lifecycle", () => {
  it("reuses the imported key for the same secret and imports a rotated secret separately", async () => {
    const firstMaterial = await generatedKey("key-one");
    const [first, repeated] = await Promise.all([
      resolveActiveSigningKey(firstMaterial.secret),
      resolveActiveSigningKey(firstMaterial.secret),
    ]);
    expect(repeated.privateKey).toBe(first.privateKey);

    const nextMaterial = await generatedKey("key-two");
    const next = await resolveActiveSigningKey(nextMaterial.secret);
    expect(next.kid).toBe("key-two");
    expect(next.privateKey).not.toBe(first.privateKey);
  });

  it("requires the configured signer to remain active and rejects revoked keys", async () => {
    const firstMaterial = await generatedKey("active-key");
    const first = await resolveActiveSigningKey(firstMaterial.secret);
    expect(() => assertActiveSigningKeyRegistered(first, firstMaterial.jwk, [firstMaterial.record])).not.toThrow();

    const nextMaterial = await generatedKey("rotated-key");
    const next = await resolveActiveSigningKey(nextMaterial.secret);
    expect(() => assertActiveSigningKeyRegistered(first, firstMaterial.jwk, [nextMaterial.record])).toThrow(
      "the active Gateway signing key must match its public key registry record",
    );
    expect(() => assertActiveSigningKeyRegistered(next, nextMaterial.jwk, [
      { ...nextMaterial.record, status: "compromised" },
    ])).toThrow("the active Gateway signing key must match its public key registry record");
  });
});
