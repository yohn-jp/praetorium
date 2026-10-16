import { describe, expect, it } from "vitest";
import type { UserId } from "../src/domain.js";
import {
  createMutationAuthorizationReceiptVerifier,
  issueMutationAuthorizationReceipt,
} from "../src/mutation-receipt.js";

const NOW = "2026-10-17T00:00:10.000Z";
const ISSUER = "https://gateway.example.test";
const AUDIENCE = "praetorium-git-publisher";
const PAYLOAD = `sha256:${"a".repeat(64)}`;

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signedReceipt(privateKey: CryptoKey, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.parse("2026-10-17T00:00:00.000Z") / 1000);
  const header = encode({ alg: "ES256", kid: "gateway-2026-01", typ: "JWT" });
  const payload = encode({
    contractVersion: "praetorium-mutation/v1",
    iss: ISSUER,
    sub: "github:42",
    aud: AUDIENCE,
    repositoryId: 1001,
    instanceId: "ins_01",
    runtimeEpoch: 4,
    operationId: "publish-01",
    payloadDigest: PAYLOAD,
    action: "publish",
    authorizationRevision: 12,
    sessionRevision: 3,
    iat: now,
    nbf: now,
    exp: now + 30,
    jti: "receipt-01",
    ...overrides,
  });
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${signingInput}.${encodedSignature}`;
}

describe("Gateway mutation authorization receipts", () => {
  it("issues a strict ES256 receipt with an enforced maximum lifetime", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const issued = await issueMutationAuthorizationReceipt(
      { kid: "gateway-2026-01", privateKey: pair.privateKey },
      {
        issuer: ISSUER,
        audience: AUDIENCE,
        subjectUserId: "github:42" as UserId,
        repositoryId: 1001,
        instanceId: "ins_01",
        runtimeEpoch: 4,
        operationId: "publish-01",
        payloadDigest: PAYLOAD,
        authorizationRevision: 12,
        sessionRevision: 3,
        now: "2026-10-17T00:00:00.000Z",
        ttlSeconds: 60,
      },
    );
    const verifier = createMutationAuthorizationReceiptVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveKey: async () => pair.publicKey,
    });

    expect(issued.descriptor.exp - issued.descriptor.iat).toBe(60);
    expect(
      await verifier.verify(issued.token, {
        repositoryId: 1001,
        instanceId: "ins_01",
        runtimeEpoch: 4,
        operationId: "publish-01",
        payloadDigest: PAYLOAD,
        now: NOW,
      }),
    ).toMatchObject({ ok: true, value: { sub: "github:42" } });
    await expect(
      issueMutationAuthorizationReceipt(
        { kid: "gateway-2026-01", privateKey: pair.privateKey },
        {
          issuer: ISSUER,
          audience: AUDIENCE,
          subjectUserId: "github:42",
          repositoryId: 1001,
          instanceId: "ins_01",
          runtimeEpoch: 4,
          operationId: "publish-01",
          payloadDigest: PAYLOAD,
          authorizationRevision: 12,
          sessionRevision: 3,
          now: NOW,
          ttlSeconds: 61,
        },
      ),
    ).rejects.toThrow();
  });

  it("verifies the Gateway signature before accepting the exact operation and payload binding", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const verifier = createMutationAuthorizationReceiptVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveKey: async (kid) => (kid === "gateway-2026-01" ? pair.publicKey : null),
    });
    const token = await signedReceipt(pair.privateKey);
    const expected = {
      repositoryId: 1001,
      instanceId: "ins_01",
      runtimeEpoch: 4,
      operationId: "publish-01",
      payloadDigest: PAYLOAD,
      now: NOW,
    };

    const valid = await verifier.verify(token, expected);
    const wrongPayload = await verifier.verify(token, {
      ...expected,
      payloadDigest: `sha256:${"b".repeat(64)}`,
    });
    const wrongEpoch = await verifier.verify(token, { ...expected, runtimeEpoch: 5 });
    const atExpiry = await verifier.verify(token, {
      ...expected,
      now: "2026-10-17T00:00:30.000Z",
    });

    expect(valid).toMatchObject({
      ok: true,
      value: { sub: "github:42", authorizationRevision: 12, sessionRevision: 3 },
    });
    expect(wrongPayload).toMatchObject({ ok: false, error: { code: "INVALID_BINDING" } });
    expect(wrongEpoch).toMatchObject({ ok: false, error: { code: "INVALID_BINDING" } });
    expect(atExpiry).toMatchObject({ ok: false, error: { code: "INVALID_BINDING" } });
  });

  it("rejects altered signatures and unavailable key sources", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const token = await signedReceipt(pair.privateKey);
    const expected = {
      repositoryId: 1001,
      instanceId: "ins_01",
      runtimeEpoch: 4,
      operationId: "publish-01",
      payloadDigest: PAYLOAD,
      now: NOW,
    };
    const verifier = createMutationAuthorizationReceiptVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveKey: async () => pair.publicKey,
    });
    const parts = token.split(".");
    const corrupt = `${parts[0]}.${parts[1]}.${"A".repeat(parts[2]?.length ?? 0)}`;
    const unavailable = createMutationAuthorizationReceiptVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveKey: async () => {
        throw new Error("temporary key-store failure");
      },
    });

    expect(await verifier.verify(corrupt, expected)).toMatchObject({
      ok: false,
      error: { code: "BAD_SIGNATURE" },
    });
    expect(await unavailable.verify(token, expected)).toMatchObject({
      ok: false,
      error: { code: "KEY_SOURCE_UNAVAILABLE" },
    });
  });
});
