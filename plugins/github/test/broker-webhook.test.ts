import { describe, expect, it } from "vitest";
import { createGitCredentialBroker } from "../src/credential-broker.js";
import { verifyAndClaimGitHubWebhook } from "../src/webhooks.js";
import type { RepositoryBinding, RuntimeIdentity, RuntimeIdentityProof } from "../src/types.js";
import type { GitHubWebhookDeliveryStore } from "../src/webhooks.js";

const repoBinding: RepositoryBinding = {
  repositoryId: 1001,
  installationId: 71,
  owner: "org",
  name: "sample",
  instanceId: "ins_01",
  runtimeEpoch: 4,
  authorizationRevision: 12,
  bindingEpoch: 3,
  status: "active",
};

function proof(): RuntimeIdentityProof {
  return {
    serviceToken: "runtime-secret",
    runtimeId: "rt_01",
    instanceId: "ins_01",
    repositoryId: 1001,
    installationId: 71,
    runtimeEpoch: 4,
    leaseId: "lease_01",
  };
}

const identity: RuntimeIdentity = {
  runtimeId: "rt_01",
  instanceId: "ins_01",
  repositoryId: 1001,
  installationId: 71,
  runtimeEpoch: 4,
  leaseId: "lease_01",
};

function broker(input?: { readonly epoch?: number; readonly actorAllowed?: boolean }) {
  const minted: Array<{ repositoryId: number; permission: string }> = [];
  const currentIdentity = { ...identity, runtimeEpoch: input?.epoch ?? 4 };
  const service = createGitCredentialBroker({
    runtimeAuthenticator: { authenticate: async () => currentIdentity },
    runtimeBindings: {
      getCurrent: async () => ({
        repositoryId: 1001,
        installationId: 71,
        instanceId: "ins_01",
        runtimeEpoch: 4,
        leaseId: "lease_01",
        active: true,
      }),
    },
    repositoryBindings: { getByRepositoryId: async () => repoBinding },
    accessProvider: {
      checkBoundAccess: async () =>
        input?.actorAllowed === false
          ? { status: "denied" }
          : {
              status: "allowed",
              repositoryId: 1001,
              installationId: 71,
              instanceId: "ins_01",
              runtimeEpoch: 4,
              authorizationRevision: 12,
              permissions: ["read", "write"],
              checkedAt: Date.parse("2026-10-17T00:00:00Z"),
              expiresAt: Date.parse("2026-10-17T00:00:30Z"),
            },
    },
    tokenIssuer: {
      issue: async (installationId, repositoryId, permission) => {
        expect(installationId).toBe(71);
        minted.push({ repositoryId, permission });
        return {
          token: "opaque-install-token",
          expiresAt: "2026-10-17T01:00:00.000Z",
          installationId,
          repositoryId,
          permission,
        };
      },
    },
    now: () => new Date("2026-10-17T00:00:00.000Z"),
  });
  return { service, minted };
}

describe("runtime-scoped Git credentials", () => {
  it("issues only one-repository read credentials for a current runtime binding", async () => {
    const { service, minted } = broker();
    const issued = await service.issue({ proof: proof(), operation: "fetch" });
    expect(issued).toMatchObject({
      status: "issued",
      credential: {
        repositoryId: 1001,
        permission: "read",
        runtimeEpoch: 4,
        token: "opaque-install-token",
      },
    });
    expect(minted).toEqual([{ repositoryId: 1001, permission: "read" }]);
  });

  it("requires a fresh current actor write authorization before publishing", async () => {
    const denied = broker({ actorAllowed: false });
    expect(
      await denied.service.issue({ proof: proof(), operation: "publish", actorUserId: "42" }),
    ).toMatchObject({ status: "denied" });
    expect(denied.minted).toHaveLength(0);

    const allowed = broker();
    expect(
      await allowed.service.issue({ proof: proof(), operation: "publish", actorUserId: "42" }),
    ).toMatchObject({ status: "issued", credential: { permission: "write" } });
    expect(allowed.minted).toEqual([{ repositoryId: 1001, permission: "write" }]);
  });

  it("rejects stale runtime epochs before minting any installation token", async () => {
    const stale = broker({ epoch: 3 });
    expect(await stale.service.issue({ proof: proof(), operation: "fetch" })).toMatchObject({
      status: "denied",
    });
    expect(stale.minted).toHaveLength(0);
  });
});

describe("GitHub webhook verification and deduplication", () => {
  it("verifies the exact raw body before claiming a delivery, then rejects replay", async () => {
    const secret = "webhook-secret";
    const rawBody = new TextEncoder().encode(
      JSON.stringify({
        action: "removed",
        installation: { id: 71 },
        repository: { id: 1001 },
      }),
    );
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = `sha256=${[...new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
    const ids = new Set<string>();
    const store: GitHubWebhookDeliveryStore = {
      claim: async (deliveryId) => {
        if (ids.has(deliveryId)) return false;
        ids.add(deliveryId);
        return true;
      },
    };
    const input = {
      signature,
      deliveryId: "delivery-1",
      event: "installation_repositories",
      rawBody,
      receivedAt: "2026-10-17T00:00:00.000Z",
    };

    expect(await verifyAndClaimGitHubWebhook(secret, store, input)).toMatchObject({
      status: "accepted",
      delivery: { installationId: 71, repositoryIds: [1001], action: "removed" },
    });
    expect(await verifyAndClaimGitHubWebhook(secret, store, input)).toEqual({
      status: "duplicate",
      deliveryId: "delivery-1",
    });
    expect(
      await verifyAndClaimGitHubWebhook(secret, store, {
        ...input,
        rawBody: new TextEncoder().encode("{}"),
      }),
    ).toEqual({ status: "invalid" });
  });
});
