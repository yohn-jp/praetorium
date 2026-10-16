import { describe, expect, it } from "vitest";
import { createMcpCredential } from "../src/credential/lifecycle.js";
import { exchangeMcpCredentialForAccessToken } from "../src/credential/token-exchange.js";
import { verifyAccessGrant } from "../src/access-grant.js";
import { createInMemoryMcpCredentialStore } from "../src/testing/in-memory-mcp-credential-store.js";
import type { McpCredentialId, UserId } from "../src/domain.js";

const NOW = "2026-10-17T00:00:00.000Z";
const ORIGIN = "https://ins-01.instances.example";
const USER = "github:maintainer-42" as UserId;
const PEPPER = new Uint8Array(32).fill(17);

describe("repository-bound MCP token exchange", () => {
  it("derives the grant audience from fresh trusted authority, never from request input", async () => {
    const credentialStore = createInMemoryMcpCredentialStore();
    const created = await createMcpCredential(credentialStore, {
      id: "mcp_01JATJ2BW7D5SE60Z9RFF3DSK6" as McpCredentialId,
      userId: USER,
      sessionRevision: 3,
      repositoryId: 1001,
      instanceId: "ins_01",
      runtimeEpoch: 4,
      name: "automation",
      permissions: ["read", "write"],
      now: NOW,
      ttlSeconds: 3600,
      pepper: PEPPER,
    });
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const input = {
      credentialPlaintext: created.plaintext,
      requestedRepositoryId: 1001,
      requestedInstanceId: "ins_01",
      requestedRuntimeEpoch: 4,
      requestedPermissions: ["read", "write"] as const,
      now: NOW,
      rateLimitKey: "client-1",
      audience: "https://attacker.example.test",
    };
    const exchange = await exchangeMcpCredentialForAccessToken(
      {
        credentialStore,
        credentialPepper: PEPPER,
        repositoryAccessChecker: {
          checkBoundAccess: async () => ({
            status: "allowed",
            repositoryId: 1001,
            installationId: 71,
            instanceId: "ins_01",
            origin: ORIGIN,
            runtimeEpoch: 4,
            authorizationRevision: 12,
            permissions: ["read", "write"],
            checkedAt: Date.parse(NOW),
            expiresAt: Date.parse("2026-10-17T00:00:30.000Z"),
          }),
        },
        rateLimiter: { consume: async () => true },
        signingKey: { kid: "instance-key", privateKey: pair.privateKey },
        issuer: "https://gateway.example.test",
        tokenTtlSeconds: 300,
        lastUsedBucketSeconds: 60,
      },
      input,
    );

    expect(exchange.ok).toBe(true);
    if (!exchange.ok) return;
    const verified = await verifyAccessGrant({
      token: exchange.value.token,
      expectedIssuer: "https://gateway.example.test",
      expectedAudience: ORIGIN,
      expectedInstanceId: "ins_01",
      expectedRepositoryId: 1001,
      expectedRuntimeEpoch: 4,
      now: NOW,
      clockSkewSeconds: 0,
      resolveKey: async () => pair.publicKey,
    });
    const attackerAudience = await verifyAccessGrant({
      token: exchange.value.token,
      expectedIssuer: "https://gateway.example.test",
      expectedAudience: input.audience,
      expectedInstanceId: "ins_01",
      expectedRepositoryId: 1001,
      expectedRuntimeEpoch: 4,
      now: NOW,
      clockSkewSeconds: 0,
      resolveKey: async () => pair.publicKey,
    });

    expect(verified).toMatchObject({
      ok: true,
      value: { aud: ORIGIN, permissions: ["read", "write"] },
    });
    expect(attackerAudience).toMatchObject({ ok: false, error: { code: "WRONG_AUDIENCE" } });
  });

  it("denies changed repository authority and revoked or expired credentials", async () => {
    const credentialStore = createInMemoryMcpCredentialStore();
    const created = await createMcpCredential(credentialStore, {
      id: "mcp_01JATJ2BW7D5SE60Z9RFF3DSK6" as McpCredentialId,
      userId: USER,
      sessionRevision: 3,
      repositoryId: 1001,
      instanceId: "ins_01",
      runtimeEpoch: 4,
      name: "automation",
      permissions: ["read"],
      now: NOW,
      ttlSeconds: 30,
      pepper: PEPPER,
    });
    const base = {
      credentialStore,
      credentialPepper: PEPPER,
      repositoryAccessChecker: {
        checkBoundAccess: async () => ({ status: "denied" as const }),
      },
      rateLimiter: { consume: async () => true },
      signingKey: {
        kid: "unused",
        privateKey: await crypto.subtle
          .generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
          .then((pair) => pair.privateKey),
      },
      issuer: "https://gateway.example.test",
      tokenTtlSeconds: 300,
      lastUsedBucketSeconds: 60,
    };
    const input = {
      credentialPlaintext: created.plaintext,
      requestedRepositoryId: 1001,
      requestedInstanceId: "ins_01",
      requestedRuntimeEpoch: 4,
      requestedPermissions: ["read"] as const,
      now: NOW,
      rateLimitKey: "client-1",
    };

    expect(await exchangeMcpCredentialForAccessToken(base, input)).toMatchObject({
      ok: false,
      error: { code: "INSTANCE_BLOCKED" },
    });
    expect(
      await exchangeMcpCredentialForAccessToken(base, {
        ...input,
        now: "2026-10-17T00:00:30.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_CREDENTIAL" } });
  });
});
