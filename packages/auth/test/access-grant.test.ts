import { describe, expect, it } from "vitest";
import { AccessGrantId, issueAccessGrant, verifyAccessGrant } from "../src/index.js";

describe("repository-bound access grants", () => {
  it("signs the strict T01 claims and rejects the wrong repository or runtime epoch", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const issued = await issueAccessGrant(
      { kid: "active-key", privateKey: pair.privateKey },
      {
        id: AccessGrantId.parse("agr_01JATJ2BW7D5SE60Z9RFF3DSK6"),
        issuer: "https://gateway.example.test",
        audience: "https://sample.example.test",
        subjectUserId: "github:4242",
        repositoryId: 1001,
        audienceInstanceId: "ins_01",
        runtimeEpoch: 4,
        permissions: ["read", "write"],
        sessionRevision: 2,
        authorizationRevision: 12,
        now: "2026-10-17T00:00:00.000Z",
        ttlSeconds: 300,
      },
    );
    expect(issued.descriptor).toMatchObject({
      sub: "github:4242",
      aud: "https://sample.example.test",
      instanceId: "ins_01",
      repositoryId: 1001,
      runtimeEpoch: 4,
      permissions: ["read", "write"],
      sessionRevision: 2,
      authorizationRevision: 12,
      exp: issued.descriptor.iat + 300,
    });
    const valid = await verifyAccessGrant({
      token: issued.token,
      expectedIssuer: "https://gateway.example.test",
      expectedAudience: "https://sample.example.test",
      expectedInstanceId: "ins_01",
      expectedRepositoryId: 1001,
      expectedRuntimeEpoch: 4,
      now: "2026-10-17T00:00:01.000Z",
      clockSkewSeconds: 0,
      resolveKey: async (kid) => (kid === "active-key" ? pair.publicKey : null),
    });
    const wrongRepository = await verifyAccessGrant({
      token: issued.token,
      expectedIssuer: "https://gateway.example.test",
      expectedAudience: "https://sample.example.test",
      expectedInstanceId: "ins_01",
      expectedRepositoryId: 1002,
      expectedRuntimeEpoch: 4,
      now: "2026-10-17T00:00:01.000Z",
      clockSkewSeconds: 0,
      resolveKey: async () => pair.publicKey,
    });
    const exactExpiry = await verifyAccessGrant({
      token: issued.token,
      expectedIssuer: "https://gateway.example.test",
      expectedAudience: "https://sample.example.test",
      expectedInstanceId: "ins_01",
      expectedRepositoryId: 1001,
      expectedRuntimeEpoch: 4,
      now: new Date(issued.descriptor.exp * 1000).toISOString(),
      clockSkewSeconds: 0,
      resolveKey: async () => pair.publicKey,
    });
    const invalidClock = await verifyAccessGrant({
      token: issued.token,
      expectedIssuer: "https://gateway.example.test",
      expectedAudience: "https://sample.example.test",
      expectedInstanceId: "ins_01",
      expectedRepositoryId: 1001,
      expectedRuntimeEpoch: 4,
      now: "not-a-date",
      clockSkewSeconds: 0,
      resolveKey: async () => pair.publicKey,
    });
    const invalidSkew = await verifyAccessGrant({
      token: issued.token,
      expectedIssuer: "https://gateway.example.test",
      expectedAudience: "https://sample.example.test",
      expectedInstanceId: "ins_01",
      expectedRepositoryId: 1001,
      expectedRuntimeEpoch: 4,
      now: "2026-10-17T00:00:01.000Z",
      clockSkewSeconds: Number.NaN,
      resolveKey: async () => pair.publicKey,
    });
    const wrongAudience = await verifyAccessGrant({
      token: issued.token,
      expectedIssuer: "https://gateway.example.test",
      expectedAudience: "https://attacker.example.test",
      expectedInstanceId: "ins_01",
      expectedRepositoryId: 1001,
      expectedRuntimeEpoch: 4,
      now: "2026-10-17T00:00:01.000Z",
      clockSkewSeconds: 0,
      resolveKey: async () => pair.publicKey,
    });
    expect(valid.ok).toBe(true);
    expect(wrongRepository).toMatchObject({ ok: false, error: { code: "WRONG_REPOSITORY" } });
    expect(exactExpiry).toMatchObject({ ok: false, error: { code: "EXPIRED" } });
    expect(invalidClock).toMatchObject({ ok: false, error: { code: "INVALID_TIME" } });
    expect(invalidSkew).toMatchObject({ ok: false, error: { code: "INVALID_TIME" } });
    expect(wrongAudience).toMatchObject({ ok: false, error: { code: "WRONG_AUDIENCE" } });
  });
});
