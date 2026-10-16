import { describe, expect, it } from "vitest";
import { createMutationAuthorizationReceiptVerifier } from "@praetorium/auth";
import { createGitCredentialBroker } from "../src/credential-broker.js";
import { verifyAndClaimGitHubWebhook } from "../src/webhooks.js";
import type { RepositoryBinding, RuntimeIdentity, RuntimeIdentityProof } from "../src/types.js";
import type { GitHubWebhookDeliveryStore } from "../src/webhooks.js";

const NOW = "2026-10-17T00:00:00.000Z";
const OPERATION_ID = "operation-01";
const PAYLOAD_DIGEST = `sha256:${"a".repeat(64)}`;
const RECEIPT_ISSUER = "https://gateway.example.test";
const RECEIPT_AUDIENCE = "praetorium-git-publisher";

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signMutationReceipt(privateKey: CryptoKey, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.parse(NOW) / 1000);
  const header = b64url(
    new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: "gateway-key", typ: "JWT" })),
  );
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({
        contractVersion: "praetorium-mutation/v1",
        iss: RECEIPT_ISSUER,
        sub: "github:maintainer-42",
        aud: RECEIPT_AUDIENCE,
        repositoryId: 1001,
        instanceId: "ins_01",
        runtimeEpoch: 4,
        operationId: OPERATION_ID,
        payloadDigest: PAYLOAD_DIGEST,
        action: "publish",
        authorizationRevision: 12,
        sessionRevision: 7,
        iat: now,
        nbf: now,
        exp: now + 30,
        jti: "receipt-01",
        ...overrides,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

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

async function broker(input?: {
  readonly epoch?: number;
  readonly actorAllowed?: boolean;
  readonly bindingRevision?: number;
  readonly accessRevision?: number;
}) {
  const minted: Array<{ repositoryId: number; permission: string }> = [];
  const authorizedUsers: string[] = [];
  const currentIdentity = { ...identity, runtimeEpoch: input?.epoch ?? 4 };
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const verifier = createMutationAuthorizationReceiptVerifier({
    issuer: RECEIPT_ISSUER,
    audience: RECEIPT_AUDIENCE,
    resolveKey: async (kid) => (kid === "gateway-key" ? pair.publicKey : null),
  });
  const receipt = await signMutationReceipt(pair.privateKey);
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
    repositoryBindings: {
      getByRepositoryId: async () => ({
        ...repoBinding,
        authorizationRevision: input?.bindingRevision ?? repoBinding.authorizationRevision,
      }),
    },
    mutationReceiptVerifier: verifier,
    accessProvider: {
      checkBoundAccess: async (userId) => {
        authorizedUsers.push(userId);
        return input?.actorAllowed === false
          ? { status: "denied" }
          : {
              status: "allowed",
              repositoryId: 1001,
              installationId: 71,
              instanceId: "ins_01",
              runtimeEpoch: 4,
              authorizationRevision: input?.accessRevision ?? 12,
              permissions: ["read", "write"],
              origin: "https://ins-01.instances.example",
              checkedAt: Date.parse(NOW),
              expiresAt: Date.parse("2026-10-17T00:00:30Z"),
            };
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
    now: () => new Date(NOW),
  });
  return { service, minted, authorizedUsers, receipt };
}

describe("runtime-scoped Git credentials", () => {
  it("issues only one-repository read credentials for a current runtime binding", async () => {
    const { service, minted } = await broker();
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
    const denied = await broker({ actorAllowed: false });
    expect(
      await denied.service.issue({
        proof: proof(),
        operation: "publish",
        mutationReceipt: denied.receipt,
        operationId: OPERATION_ID,
        payloadDigest: PAYLOAD_DIGEST,
      }),
    ).toMatchObject({ status: "denied" });
    expect(denied.minted).toHaveLength(0);
    expect(denied.authorizedUsers).toEqual(["github:maintainer-42"]);

    const allowed = await broker();
    expect(
      await allowed.service.issue({
        proof: proof(),
        operation: "publish",
        mutationReceipt: allowed.receipt,
        operationId: OPERATION_ID,
        payloadDigest: PAYLOAD_DIGEST,
      }),
    ).toMatchObject({ status: "issued", credential: { permission: "write" } });
    expect(allowed.minted).toEqual([{ repositoryId: 1001, permission: "write" }]);
    expect(allowed.authorizedUsers).toEqual(["github:maintainer-42"]);
  });

  it("rejects stale revisions and exact operation/payload mismatches before minting", async () => {
    const stale = await broker({ bindingRevision: 13 });
    expect(
      await stale.service.issue({
        proof: proof(),
        operation: "publish",
        mutationReceipt: stale.receipt,
        operationId: OPERATION_ID,
        payloadDigest: PAYLOAD_DIGEST,
      }),
    ).toMatchObject({ status: "denied" });
    expect(stale.minted).toHaveLength(0);

    const valid = await broker();
    expect(
      await valid.service.issue({
        proof: proof(),
        operation: "publish",
        mutationReceipt: valid.receipt,
        operationId: OPERATION_ID,
        payloadDigest: `sha256:${"b".repeat(64)}`,
      }),
    ).toMatchObject({ status: "denied" });
    expect(valid.authorizedUsers).toHaveLength(0);
    expect(valid.minted).toHaveLength(0);

    const staleFreshCheck = await broker({ accessRevision: 13 });
    expect(
      await staleFreshCheck.service.issue({
        proof: proof(),
        operation: "publish",
        mutationReceipt: staleFreshCheck.receipt,
        operationId: OPERATION_ID,
        payloadDigest: PAYLOAD_DIGEST,
      }),
    ).toMatchObject({ status: "denied" });
    expect(staleFreshCheck.minted).toHaveLength(0);
  });

  it("does not ask GitHub or mint a token for a forged Gateway signature", async () => {
    const forged = await broker();
    const [header, payload, signature] = forged.receipt.split(".");
    const binary = atob((signature ?? "").replaceAll("-", "+").replaceAll("_", "/"));
    const signatureBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    signatureBytes[0] = (signatureBytes[0] ?? 0) ^ 1;
    const alteredReceipt = `${header}.${payload}.${b64url(signatureBytes)}`;
    expect(
      await forged.service.issue({
        proof: proof(),
        operation: "publish",
        mutationReceipt: alteredReceipt,
        operationId: OPERATION_ID,
        payloadDigest: PAYLOAD_DIGEST,
      }),
    ).toMatchObject({ status: "denied" });
    expect(forged.authorizedUsers).toHaveLength(0);
    expect(forged.minted).toHaveLength(0);
  });

  it("rejects stale runtime epochs before minting any installation token", async () => {
    const stale = await broker({ epoch: 3 });
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
