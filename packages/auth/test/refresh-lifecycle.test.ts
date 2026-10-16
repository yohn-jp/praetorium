import { describe, expect, it } from "vitest";
import { verifyAccessGrant } from "../src/access-grant.js";
import type { UserId } from "../src/domain.js";
import { createAccessRefreshCredential, refreshAccessGrant } from "../src/refresh/lifecycle.js";
import { createSession } from "../src/session/lifecycle.js";
import { createInMemoryAccessRefreshCredentialStore } from "../src/testing/in-memory-access-refresh-store.js";
import { createInMemorySessionStore } from "../src/testing/in-memory-session-store.js";

const NOW = "2026-10-17T00:00:00.000Z";
const ORIGIN = "https://sample.example.test";
const PEPPER = new Uint8Array(32).fill(31);
const USER = "github:4242" as UserId;

describe("repository-bound access refresh", () => {
  it("rechecks current access, intersects permissions, and atomically rotates the chain", async () => {
    const sessionStore = createInMemorySessionStore();
    const sessions = await createSession(sessionStore, {
      userId: USER,
      authenticationContext: "github-oauth",
      now: NOW,
      ttlSeconds: 3600,
      pepper: PEPPER,
      concurrentSessionLimit: 5,
    });
    if (!sessions.ok) throw new Error("session fixture failed");
    const credentialStore = createInMemoryAccessRefreshCredentialStore();
    const initial = await createAccessRefreshCredential(credentialStore, {
      userId: USER,
      gatewaySessionDigest: sessions.value.digest,
      repositoryId: 1001,
      instanceId: "ins_01",
      runtimeEpoch: 4,
      origin: ORIGIN,
      permissions: ["read", "write"],
      now: NOW,
      sessionExpiresAt: sessions.value.record.expiresAt,
      pepper: PEPPER,
    });
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const dependencies = {
      credentialStore,
      credentialPepper: PEPPER,
      sessionStore,
      repositoryAccessChecker: {
        checkBoundAccess: async () => ({
          status: "allowed" as const,
          repositoryId: 1001,
          installationId: 71,
          instanceId: "ins_01",
          origin: ORIGIN,
          runtimeEpoch: 4,
          authorizationRevision: 14,
          permissions: ["read"] as const,
          checkedAt: Date.parse(NOW),
          expiresAt: Date.parse("2026-10-17T00:00:30.000Z"),
        }),
      },
      signingKey: { kid: "instance-key", privateKey: pair.privateKey },
      issuer: "https://gateway.example.test",
      tokenTtlSeconds: 300,
    };
    const input = {
      plaintext: initial.plaintext,
      repositoryId: 1001,
      instanceId: "ins_01",
      runtimeEpoch: 4,
      origin: ORIGIN,
      now: NOW,
    };

    const refreshed = await refreshAccessGrant(dependencies, input);
    expect(refreshed).toMatchObject({
      ok: true,
      value: { refreshExpiresAt: sessions.value.record.expiresAt },
    });
    if (!refreshed.ok) return;
    const grant = await verifyAccessGrant({
      token: refreshed.value.token,
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
      value: { permissions: ["read"], sessionRevision: 0, authorizationRevision: 14 },
    });
    expect(await refreshAccessGrant(dependencies, input)).toMatchObject({
      ok: false,
      error: { code: "INVALID_CREDENTIAL" },
    });

    const rotated = await refreshAccessGrant(dependencies, {
      ...input,
      plaintext: refreshed.value.refreshCredential,
    });
    expect(rotated.ok).toBe(true);
  });

  it("rejects stale origin/epoch, unavailable current authority, and revoked sessions", async () => {
    const modes = [
      "wrong-origin",
      "wrong-epoch",
      "authority-unavailable",
      "revoked-session",
    ] as const;
    for (const mode of modes) {
      const sessionStore = createInMemorySessionStore();
      const sessions = await createSession(sessionStore, {
        userId: USER,
        authenticationContext: "github-oauth",
        now: NOW,
        ttlSeconds: 3600,
        pepper: PEPPER,
        concurrentSessionLimit: 5,
      });
      if (!sessions.ok) throw new Error("session fixture failed");
      const credentialStore = createInMemoryAccessRefreshCredentialStore();
      const initial = await createAccessRefreshCredential(credentialStore, {
        userId: USER,
        gatewaySessionDigest: sessions.value.digest,
        repositoryId: 1001,
        instanceId: "ins_01",
        runtimeEpoch: 4,
        origin: ORIGIN,
        permissions: ["read"],
        now: NOW,
        sessionExpiresAt: sessions.value.record.expiresAt,
        pepper: PEPPER,
      });
      if (mode === "revoked-session") await sessionStore.revoke(sessions.value.digest, NOW);
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]);
      const result = await refreshAccessGrant(
        {
          credentialStore,
          credentialPepper: PEPPER,
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
                : mode === "wrong-epoch"
                  ? { status: "denied" as const }
                  : mode === "authority-unavailable"
                    ? { status: "unavailable" as const }
                    : { status: "denied" as const },
          },
          signingKey: { kid: "instance-key", privateKey: pair.privateKey },
          issuer: "https://gateway.example.test",
          tokenTtlSeconds: 300,
        },
        {
          plaintext: initial.plaintext,
          repositoryId: 1001,
          instanceId: "ins_01",
          runtimeEpoch: 4,
          origin: ORIGIN,
          now: NOW,
        },
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          code:
            mode === "wrong-origin" || mode === "wrong-epoch"
              ? "INSTANCE_BLOCKED"
              : mode === "authority-unavailable"
                ? "AUTHORITY_UNAVAILABLE"
                : "SESSION_INVALID",
        },
      });
    }
  });
});
