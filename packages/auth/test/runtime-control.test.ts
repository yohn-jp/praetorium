import { describe, expect, it } from "vitest";
import {
  createRuntimeControlCredentialVerifier,
  issueRuntimeControlCredential,
} from "../src/runtime-control.js";

const NOW = "2026-10-17T00:00:10.000Z";
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);
const ISSUER = "https://control.example.test";
const AUDIENCE = "praetorium-runtime-control";
const PAYLOAD = `sha256:${"a".repeat(64)}`;

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signClaims(privateKey: CryptoKey, claims: unknown): Promise<string> {
  const header = encode({ alg: "ES256", kid: "control-2026-01", typ: "JWT" });
  const payload = encode(claims);
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

describe("Control Plane runtime-control credentials", () => {
  it("issues and verifies each allowed action with an enforced 60-second maximum", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const verifier = createRuntimeControlCredentialVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveKey: async (kid) => (kid === "control-2026-01" ? pair.publicKey : null),
    });

    for (const action of ["status", "quiesce", "resume"] as const) {
      const issued = await issueRuntimeControlCredential(
        { kid: "control-2026-01", privateKey: pair.privateKey },
        {
          issuer: ISSUER,
          audience: AUDIENCE,
          subject: "control-plane:provisioner",
          instanceId: "ins_01",
          repositoryId: 1001,
          runtimeEpoch: 4,
          operationId: "runtime-op-01",
          action,
          payloadDigest: PAYLOAD,
          now: NOW,
          ttlSeconds: 60,
        },
      );

      expect(issued.descriptor).toMatchObject({
        contractVersion: "praetorium-runtime-control/v1",
        sub: "control-plane:provisioner",
        action,
        iat: NOW_SECONDS,
        exp: NOW_SECONDS + 60,
      });
      await expect(
        verifier.verify(issued.token, {
          instanceId: "ins_01",
          repositoryId: 1001,
          runtimeEpoch: 4,
          operationId: "runtime-op-01",
          action,
          payloadDigest: PAYLOAD,
          now: NOW,
        }),
      ).resolves.toMatchObject({ ok: true, value: { action, repositoryId: 1001 } });
    }

    await expect(
      issueRuntimeControlCredential(
        { kid: "control-2026-01", privateKey: pair.privateKey },
        {
          issuer: ISSUER,
          audience: AUDIENCE,
          subject: "control-plane:provisioner",
          instanceId: "ins_01",
          repositoryId: 1001,
          runtimeEpoch: 4,
          operationId: "runtime-op-01",
          action: "status",
          payloadDigest: PAYLOAD,
          now: NOW,
          ttlSeconds: 61,
        },
      ),
    ).rejects.toThrow("between 1 and 60 seconds");
  });

  it("rejects wrong action, operation, repository, runtime epoch, payload and exact expiry", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const issued = await issueRuntimeControlCredential(
      { kid: "control-2026-01", privateKey: pair.privateKey },
      {
        issuer: ISSUER,
        audience: AUDIENCE,
        subject: "control-plane:provisioner",
        instanceId: "ins_01",
        repositoryId: 1001,
        runtimeEpoch: 4,
        operationId: "runtime-op-01",
        action: "quiesce",
        payloadDigest: PAYLOAD,
        now: NOW,
        ttlSeconds: 20,
      },
    );
    const verifier = createRuntimeControlCredentialVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveKey: async () => pair.publicKey,
    });
    const expected = {
      instanceId: "ins_01",
      repositoryId: 1001,
      runtimeEpoch: 4,
      operationId: "runtime-op-01",
      action: "quiesce" as const,
      payloadDigest: PAYLOAD,
      now: NOW,
    };

    for (const binding of [
      { ...expected, action: "resume" as const },
      { ...expected, operationId: "runtime-op-02" },
      { ...expected, repositoryId: 1002 },
      { ...expected, runtimeEpoch: 5 },
      { ...expected, payloadDigest: `sha256:${"b".repeat(64)}` },
      { ...expected, now: "2026-10-17T00:00:30.000Z" },
      { ...expected, now: "not-a-time" },
    ]) {
      await expect(verifier.verify(issued.token, binding)).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_BINDING" },
      });
    }
  });

  it("requires the expected issuer and audience, rejects unknown keys and verifies signatures", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const issued = await issueRuntimeControlCredential(
      { kid: "control-2026-01", privateKey: pair.privateKey },
      {
        issuer: ISSUER,
        audience: AUDIENCE,
        subject: "control-plane:provisioner",
        instanceId: "ins_01",
        repositoryId: 1001,
        runtimeEpoch: 4,
        operationId: "runtime-op-01",
        action: "status",
        payloadDigest: PAYLOAD,
        now: NOW,
        ttlSeconds: 30,
      },
    );
    const expected = {
      instanceId: "ins_01",
      repositoryId: 1001,
      runtimeEpoch: 4,
      operationId: "runtime-op-01",
      action: "status" as const,
      payloadDigest: PAYLOAD,
      now: NOW,
    };
    const verifier = createRuntimeControlCredentialVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveKey: async (kid) => (kid === "control-2026-01" ? pair.publicKey : null),
    });
    const unknownKeyVerifier = createRuntimeControlCredentialVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveKey: async () => null,
    });
    const unavailableVerifier = createRuntimeControlCredentialVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveKey: async () => {
        throw new Error("temporary key registry failure");
      },
    });

    await expect(
      createRuntimeControlCredentialVerifier({
        issuer: "https://wrong.example.test",
        audience: AUDIENCE,
        resolveKey: async () => pair.publicKey,
      }).verify(issued.token, expected),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_BINDING" } });
    await expect(
      createRuntimeControlCredentialVerifier({
        issuer: ISSUER,
        audience: "wrong-audience",
        resolveKey: async () => pair.publicKey,
      }).verify(issued.token, expected),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_BINDING" } });
    await expect(unknownKeyVerifier.verify(issued.token, expected)).resolves.toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_KEY" },
    });
    await expect(unavailableVerifier.verify(issued.token, expected)).resolves.toMatchObject({
      ok: false,
      error: { code: "KEY_SOURCE_UNAVAILABLE" },
    });

    const pieces = issued.token.split(".");
    const changedSignature = `${pieces[0]}.${pieces[1]}.${"A".repeat(pieces[2]?.length ?? 0)}`;
    await expect(verifier.verify(changedSignature, expected)).resolves.toMatchObject({
      ok: false,
      error: { code: "BAD_SIGNATURE" },
    });
  });

  it("rejects additional JWS header members before key lookup", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const claims = {
      contractVersion: "praetorium-runtime-control/v1",
      iss: ISSUER,
      sub: "control-plane:provisioner",
      aud: AUDIENCE,
      instanceId: "ins_01",
      repositoryId: 1001,
      runtimeEpoch: 4,
      operationId: "runtime-op-01",
      action: "status",
      payloadDigest: PAYLOAD,
      iat: NOW_SECONDS,
      nbf: NOW_SECONDS,
      exp: NOW_SECONDS + 30,
      jti: "control-01",
    };
    const valid = await signClaims(pair.privateKey, claims);
    const [, payload, signature] = valid.split(".") as [string, string, string];
    const tokenWithExtraHeader = `${encode({ alg: "ES256", kid: "control-2026-01", typ: "JWT", crit: [] })}.${payload}.${signature}`;
    const resolveKey = async () => pair.publicKey;
    const verifier = createRuntimeControlCredentialVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveKey,
    });

    await expect(
      verifier.verify(tokenWithExtraHeader, {
        instanceId: "ins_01",
        repositoryId: 1001,
        runtimeEpoch: 4,
        operationId: "runtime-op-01",
        action: "status",
        payloadDigest: PAYLOAD,
        now: NOW,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "MALFORMED" } });
  });
});
