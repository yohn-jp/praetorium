import { describe, expect, it } from "vitest";
import { verifyAccessGrant } from "../src/access-grant.js";
import type { UserId } from "../src/domain.js";
import { completeInstanceHandoff } from "../src/handoff/exchange.js";
import { createHandoffCode } from "../src/handoff/lifecycle.js";
import { createSession } from "../src/session/lifecycle.js";
import { createInMemoryHandoffCodeStore } from "../src/testing/in-memory-handoff-store.js";
import { createInMemorySessionStore } from "../src/testing/in-memory-session-store.js";

const NOW = "2026-10-17T00:00:00.000Z";
const PEPPER = new Uint8Array(32).fill(23);
const USER = "github:4242" as UserId;
const ORIGIN = "https://sample.example.test";

describe("instance handoff exchange", () => {
  it("intersects requested permissions with fresh GitHub access and binds the signed grant", async () => {
    const handoffStore = createInMemoryHandoffCodeStore();
    const sessionStore = createInMemorySessionStore();
    const session = await createSession(sessionStore, {
      userId: USER,
      authenticationContext: "github-oauth",
      now: NOW,
      ttlSeconds: 3600,
      pepper: PEPPER,
      concurrentSessionLimit: 5,
    });
    if (!session.ok) throw new Error("session fixture failed");
    const handoff = await createHandoffCode(handoffStore, {
      userId: USER,
      gatewaySessionDigest: session.value.digest,
      repositoryId: 1001,
      instanceId: "ins_01",
      runtimeEpoch: 4,
      hostname: "sample.example.test",
      origin: ORIGIN,
      audience: "instance-access",
      returnPath: "/drafts",
      requestedPermissions: ["read", "write"],
      now: NOW,
      ttlSeconds: 60,
      pepper: PEPPER,
    });
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const dependencies = {
      handoffStore,
      sessionStore,
      repositoryAccessChecker: {
        checkBoundAccess: async () => ({
          status: "allowed" as const,
          repositoryId: 1001,
          installationId: 71,
          instanceId: "ins_01",
          origin: ORIGIN,
          runtimeEpoch: 4,
          authorizationRevision: 12,
          permissions: ["read"] as const,
          checkedAt: Date.parse(NOW),
          expiresAt: Date.parse("2026-10-17T00:00:30.000Z"),
        }),
      },
      codePepper: PEPPER,
      signingKey: { kid: "instance-key", privateKey: pair.privateKey },
      issuer: "https://gateway.example.test",
      tokenTtlSeconds: 300,
    };
    const input = {
      rawCode: handoff.rawCode,
      presentedHostname: "sample.example.test",
      presentedRepositoryId: 1001,
      presentedInstanceId: "ins_01",
      presentedRuntimeEpoch: 4,
      presentedOrigin: ORIGIN,
      presentedReturnPath: "/drafts",
      presentedAudience: "instance-access" as const,
      now: NOW,
    };

    const completed = await completeInstanceHandoff(dependencies, input);
    expect(completed).toMatchObject({
      ok: true,
      value: {
        userId: USER,
        repositoryId: 1001,
        instanceId: "ins_01",
        runtimeEpoch: 4,
        origin: ORIGIN,
        permissions: ["read"],
      },
    });
    if (!completed.ok) return;
    const grant = await verifyAccessGrant({
      token: completed.value.token,
      expectedIssuer: "https://gateway.example.test",
      expectedAudience: ORIGIN,
      expectedInstanceId: "ins_01",
      expectedRepositoryId: 1001,
      expectedRuntimeEpoch: 4,
      requiredPermissions: ["read"],
      now: NOW,
      clockSkewSeconds: 0,
      resolveKey: async () => pair.publicKey,
    });
    expect(grant).toMatchObject({
      ok: true,
      value: {
        sub: USER,
        aud: ORIGIN,
        permissions: ["read"],
        authorizationRevision: 12,
        sessionRevision: 0,
      },
    });
    expect(await completeInstanceHandoff(dependencies, input)).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("does not issue a grant when the authority returns a different origin or the session is revoked", async () => {
    for (const mode of ["wrong-origin", "revoked-session"] as const) {
      const handoffStore = createInMemoryHandoffCodeStore();
      const sessionStore = createInMemorySessionStore();
      const session = await createSession(sessionStore, {
        userId: USER,
        authenticationContext: "github-oauth",
        now: NOW,
        ttlSeconds: 3600,
        pepper: PEPPER,
        concurrentSessionLimit: 5,
      });
      if (!session.ok) throw new Error("session fixture failed");
      const handoff = await createHandoffCode(handoffStore, {
        userId: USER,
        gatewaySessionDigest: session.value.digest,
        repositoryId: 1001,
        instanceId: "ins_01",
        runtimeEpoch: 4,
        hostname: "sample.example.test",
        origin: ORIGIN,
        audience: "instance-access",
        returnPath: "/",
        requestedPermissions: ["read"],
        now: NOW,
        ttlSeconds: 30,
        pepper: PEPPER,
      });
      if (mode === "revoked-session") await sessionStore.revoke(session.value.digest, NOW);
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]);
      const result = await completeInstanceHandoff(
        {
          handoffStore,
          sessionStore,
          repositoryAccessChecker: {
            checkBoundAccess: async () =>
              mode === "wrong-origin"
                ? {
                    status: "allowed" as const,
                    repositoryId: 1001,
                    installationId: 71,
                    instanceId: "ins_01",
                    origin: "https://attacker.example.test",
                    runtimeEpoch: 4,
                    authorizationRevision: 12,
                    permissions: ["read"] as const,
                    checkedAt: Date.parse(NOW),
                    expiresAt: Date.parse("2026-10-17T00:00:30.000Z"),
                  }
                : { status: "denied" as const },
          },
          codePepper: PEPPER,
          signingKey: { kid: "instance-key", privateKey: pair.privateKey },
          issuer: "https://gateway.example.test",
          tokenTtlSeconds: 300,
        },
        {
          rawCode: handoff.rawCode,
          presentedHostname: "sample.example.test",
          presentedRepositoryId: 1001,
          presentedInstanceId: "ins_01",
          presentedRuntimeEpoch: 4,
          presentedOrigin: ORIGIN,
          presentedReturnPath: "/",
          presentedAudience: "instance-access",
          now: NOW,
        },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: mode === "wrong-origin" ? "INSTANCE_ACCESS_DENIED" : "SESSION_INVALID" },
      });
    }
  });
});
