import { describe, expect, it } from "vitest";
import {
  RUNTIME_IDENTITY_AUDIENCE,
  createRuntimeIdentityCredentialVerifier,
  issueRuntimeIdentityCredential,
} from "../src/runtime-identity.js";

const NOW = "2026-10-17T00:00:10.000Z";
const ISSUER = "https://control.example.test";
const BINDING = {
  runtimeId: "res_runtime-4",
  instanceId: "ins_repository-7",
  repositoryId: 7001,
  installationId: 9001,
  runtimeEpoch: 4,
  leaseId: "res_runtime-4",
};

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

async function signClaims(
  privateKey: CryptoKey,
  claims: unknown,
  header: unknown = { alg: "ES256", kid: "runtime-2026-01", typ: "JWT" },
): Promise<string> {
  const encodedHeader = encode(header);
  const encodedPayload = encode(claims);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
  return `${signingInput}.${encodedSignature}`;
}

describe("runtime service identity credentials", () => {
  it("issues and verifies a short-lived repository, installation, epoch, and lease identity", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const verifier = createRuntimeIdentityCredentialVerifier({
      issuer: ISSUER,
      resolveKey: async (kid) => (kid === "runtime-2026-01" ? pair.publicKey : null),
    });
    const issued = await issueRuntimeIdentityCredential(
      { kid: "runtime-2026-01", privateKey: pair.privateKey },
      { ...BINDING, issuer: ISSUER, now: NOW, ttlSeconds: 300, tokenId: "identity-1" },
    );

    expect(issued.descriptor).toMatchObject({
      contractVersion: "praetorium-runtime-identity/v1",
      iss: ISSUER,
      aud: RUNTIME_IDENTITY_AUDIENCE,
      sub: BINDING.runtimeId,
      runtimeId: BINDING.runtimeId,
      iat: Math.floor(Date.parse(NOW) / 1000),
      nbf: Math.floor(Date.parse(NOW) / 1000),
      exp: Math.floor(Date.parse(NOW) / 1000) + 300,
    });
    await expect(verifier.verify(issued.token, { ...BINDING, now: NOW })).resolves.toMatchObject({
      ok: true,
      value: issued.descriptor,
    });
    await expect(
      issueRuntimeIdentityCredential(
        { kid: "runtime-2026-01", privateKey: pair.privateKey },
        { ...BINDING, issuer: ISSUER, now: NOW, ttlSeconds: 301 },
      ),
    ).rejects.toThrow("between 1 and 300 seconds");
  });

  it("denies wrong audience, issuer, future issue time, expiry, and every binding mismatch", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const verifier = createRuntimeIdentityCredentialVerifier({
      issuer: ISSUER,
      resolveKey: async (kid) => (kid === "runtime-2026-01" ? pair.publicKey : null),
    });
    const issued = await issueRuntimeIdentityCredential(
      { kid: "runtime-2026-01", privateKey: pair.privateKey },
      { ...BINDING, issuer: ISSUER, now: NOW, ttlSeconds: 30 },
    );

    for (const [field, value] of [
      ["runtimeId", "res_other"],
      ["instanceId", "ins_other"],
      ["repositoryId", 7002],
      ["installationId", 9002],
      ["runtimeEpoch", 5],
      ["leaseId", "lease_other"],
    ] as const) {
      await expect(
        verifier.verify(issued.token, { ...BINDING, [field]: value, now: NOW }),
      ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_BINDING" } });
    }
    await expect(
      verifier.verify(issued.token, { ...BINDING, now: "2026-10-17T00:00:40.000Z" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_BINDING" } });

    const futureClaims = {
      ...issued.descriptor,
      iat: issued.descriptor.iat + 1,
      nbf: issued.descriptor.nbf + 1,
      exp: issued.descriptor.exp + 1,
    };
    const futureToken = await signClaims(pair.privateKey, futureClaims);
    await expect(verifier.verify(futureToken, { ...BINDING, now: NOW })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_BINDING" },
    });

    for (const override of [
      { aud: "praetorium-runtime-control" },
      { iss: "https://other.example.test" },
    ]) {
      const token = await signClaims(pair.privateKey, { ...issued.descriptor, ...override });
      await expect(verifier.verify(token, { ...BINDING, now: NOW })).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_BINDING" },
      });
    }
  });

  it("requires the exact ES256 JWT header, a known P-256 key, and a valid signature", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const wrongPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const verifier = createRuntimeIdentityCredentialVerifier({
      issuer: ISSUER,
      resolveKey: async (kid) => (kid === "runtime-2026-01" ? pair.publicKey : null),
    });
    const issued = await issueRuntimeIdentityCredential(
      { kid: "runtime-2026-01", privateKey: pair.privateKey },
      { ...BINDING, issuer: ISSUER, now: NOW, ttlSeconds: 30 },
    );
    const extraHeader = await signClaims(pair.privateKey, issued.descriptor, {
      alg: "ES256",
      kid: "runtime-2026-01",
      typ: "JWT",
      crit: ["b64"],
    });
    const wrongAlgorithm = await signClaims(pair.privateKey, issued.descriptor, {
      alg: "HS256",
      kid: "runtime-2026-01",
      typ: "JWT",
    });
    const wrongSignature = await signClaims(wrongPair.privateKey, issued.descriptor);
    const [header, payload, signature] = issued.token.split(".");
    const signatureBytes = Uint8Array.from(
      atob((signature ?? "").replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.charCodeAt(0),
    );
    signatureBytes[0] = (signatureBytes[0] ?? 0) ^ 1;
    const tamperedSignature = btoa(String.fromCharCode(...signatureBytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/u, "");
    const tampered = `${header}.${payload}.${tamperedSignature}`;

    await expect(verifier.verify(extraHeader, { ...BINDING, now: NOW })).resolves.toMatchObject({
      ok: false,
      error: { code: "MALFORMED" },
    });
    await expect(verifier.verify(wrongAlgorithm, { ...BINDING, now: NOW })).resolves.toMatchObject({
      ok: false,
      error: { code: "MALFORMED" },
    });
    await expect(verifier.verify(wrongSignature, { ...BINDING, now: NOW })).resolves.toMatchObject({
      ok: false,
      error: { code: "BAD_SIGNATURE" },
    });
    await expect(verifier.verify(tampered, { ...BINDING, now: NOW })).resolves.toMatchObject({
      ok: false,
      error: { code: "BAD_SIGNATURE" },
    });
    const unknownKey = await signClaims(pair.privateKey, issued.descriptor, {
      alg: "ES256",
      kid: "retired-key",
      typ: "JWT",
    });
    await expect(verifier.verify(unknownKey, { ...BINDING, now: NOW })).resolves.toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_KEY" },
    });
  });
});
