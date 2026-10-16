import {
  exportPublicKeyJwk,
  generateSigningKeyPair,
  issueMutationAuthorizationReceipt,
  issueRuntimeIdentityCredential,
  type KeyRecord,
  type FreshRepositoryAccessChecker,
} from "@praetorium/auth";
import type { Fetcher } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeGitCredentialBroker } from "../src/adapters/runtime-git-broker.js";

const NOW = new Date("2026-10-17T03:00:00.000Z");
const ISSUER = "https://control.example";
const GATEWAY_ORIGIN = "https://gateway.example";
const GATEWAY_AUTH = "gateway-auth-secret-0123456789abcdef";
const REPOSITORY_ID = 701;
const INSTALLATION_ID = 902;
const INSTANCE_ID = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RUNTIME_ID = "reservation-01-runtime";
const LEASE_ID = "lease-01-runtime";
const RUNTIME_EPOCH = 4;

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function appPrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = base64(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/gu)?.join("\n")}\n-----END PRIVATE KEY-----`;
}

async function setup(options: {
  accessProvider?: FreshRepositoryAccessChecker;
  githubFetchImpl?: typeof fetch;
} = {}) {
  const runtimePair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const runtimeKid = "runtime-key-1";
  const runtimePublicJwk = await exportPublicKeyJwk(runtimePair.publicKey);
  const runtimeJwks = {
    keys: [
      {
        kty: "EC",
        crv: "P-256",
        x: runtimePublicJwk.x,
        y: runtimePublicJwk.y,
        use: "sig",
        alg: "ES256",
        kid: runtimeKid,
      },
    ],
  };
  const runtimeToken = await issueRuntimeIdentityCredential(
    { kid: runtimeKid, privateKey: runtimePair.privateKey },
    {
      issuer: ISSUER,
      runtimeId: RUNTIME_ID,
      instanceId: INSTANCE_ID,
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
      runtimeEpoch: RUNTIME_EPOCH,
      leaseId: LEASE_ID,
      now: NOW.toISOString(),
      ttlSeconds: 120,
      tokenId: "test-runtime-token",
    },
  );
  const receiptPair = await generateSigningKeyPair();
  const receiptJwk = await exportPublicKeyJwk(receiptPair.publicKey);
  const keyRegistry: readonly KeyRecord[] = [
    {
      kid: "gateway-key-1",
      status: "active",
      publicKeyJwk: receiptJwk,
      createdAt: NOW.toISOString(),
      retiredAt: null,
    },
  ];
  const proof = {
    serviceToken: runtimeToken.token,
    runtimeId: RUNTIME_ID,
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    installationId: INSTALLATION_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    leaseId: LEASE_ID,
  };
  const runtimeBinding = {
    repositoryId: REPOSITORY_ID,
    installationId: INSTALLATION_ID,
    instanceId: INSTANCE_ID,
    runtimeId: RUNTIME_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    leaseId: LEASE_ID,
    clusterId: "cluster-01",
    active: true,
    authority: "observed-writer",
  };
  const githubCalls: { url: string; init: RequestInit }[] = [];
  const githubFetch: typeof fetch = options.githubFetchImpl ?? (async (input, init = {}) => {
    const url = String(input);
    githubCalls.push({ url, init });
    expect(url).toBe(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`);
    const body = JSON.parse(String(init.body)) as {
      repository_ids: number[];
      permissions: { contents: string };
    };
    expect(body).toEqual({
      repository_ids: [REPOSITORY_ID],
      permissions: { contents: "read" },
    });
    return Response.json({
      token: "ghs-scoped-installation-token",
      expires_at: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
      permissions: { contents: "read" },
      repositories: [{ id: REPOSITORY_ID }],
    });
  });
  const cpCalls: { url: string; init: RequestInit }[] = [];
  const controlPlane = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input);
      const requestInit = init ?? {};
      cpCalls.push({ url, init: requestInit });
      expect(requestInit.method).toBe("GET");
      expect(requestInit.redirect).toBe("error");
      expect(requestInit.signal).toBeInstanceOf(AbortSignal);
      if (url === `${CONTROL_PLANE_ORIGIN}/.well-known/runtime-identity-jwks.json`) {
        expect(new Headers(requestInit.headers).has("X-Control-Plane-Gateway-Auth")).toBe(false);
        return Response.json(runtimeJwks);
      }
      expect(url).toBe(`${CONTROL_PLANE_ORIGIN}/internal/runtime-bindings/${REPOSITORY_ID}`);
      expect(new Headers(requestInit.headers).get("X-Control-Plane-Gateway-Auth")).toBe(GATEWAY_AUTH);
      return Response.json(runtimeBinding);
    },
  } as unknown as Fetcher;
  const repositoryBindings = {
    async getByRepositoryId(repositoryId: number) {
      expect(repositoryId).toBe(REPOSITORY_ID);
      return {
        repositoryId,
        installationId: INSTALLATION_ID,
        owner: "praetorium",
        name: "runtime",
        instanceId: INSTANCE_ID,
        // The Gateway user-access binding intentionally still reflects the observed writer.
        runtimeEpoch: RUNTIME_EPOCH - 1,
        authorizationRevision: 8,
        bindingEpoch: 2,
        status: "active" as const,
      };
    },
  };
  const accessProvider = options.accessProvider ?? {
    checkBoundAccess: vi.fn(async () => ({ status: "denied" as const })),
  };
  const broker = createRuntimeGitCredentialBroker({
    controlPlane,
    controlPlaneGatewayAuth: GATEWAY_AUTH,
    runtimeIdentityIssuer: ISSUER,
    gatewayOrigin: GATEWAY_ORIGIN,
    githubAppId: 12345,
    githubAppPrivateKeyPem: await appPrivateKeyPem(),
    repositoryBindings,
    accessProvider,
    gatewayKeyRegistry: keyRegistry,
    controlPlaneTimeoutMs: 100,
    now: () => NOW,
    githubFetchImpl: githubFetch,
  });
  return { broker, proof, cpCalls, githubCalls, accessProvider, runtimeJwks, receiptPair };
}

const CONTROL_PLANE_ORIGIN = "https://control-plane.internal";

describe("runtime Git credential broker composition", () => {
  it("uses fixed authenticated Control Plane binding reads and the scoped GitHub App issuer", async () => {
    const h = await setup();
    const result = await h.broker.issue({ proof: h.proof, operation: "fetch" });

    expect(result).toMatchObject({
      status: "issued",
      credential: {
        username: "x-access-token",
        token: "ghs-scoped-installation-token",
        repositoryId: REPOSITORY_ID,
        permission: "read",
        runtimeEpoch: RUNTIME_EPOCH,
      },
    });
    expect(h.cpCalls.map(({ url }) => url)).toEqual([
      `${CONTROL_PLANE_ORIGIN}/.well-known/runtime-identity-jwks.json`,
      `${CONTROL_PLANE_ORIGIN}/internal/runtime-bindings/${REPOSITORY_ID}`,
      `${CONTROL_PLANE_ORIGIN}/internal/runtime-bindings/${REPOSITORY_ID}`,
    ]);
    expect(h.githubCalls).toHaveLength(1);
    expect(h.accessProvider.checkBoundAccess).not.toHaveBeenCalled();
  });

  it("fails closed when the public identity-key response exceeds its byte bound", async () => {
    const h = await setup();
    const oversizedControlPlane = {
      async fetch() {
        return new Response(" ".repeat(17_000), {
          headers: { "Content-Type": "application/json" },
        });
      },
    } as unknown as Fetcher;
    const failingBroker = createRuntimeGitCredentialBroker({
      controlPlane: oversizedControlPlane,
      controlPlaneGatewayAuth: GATEWAY_AUTH,
      runtimeIdentityIssuer: ISSUER,
      gatewayOrigin: GATEWAY_ORIGIN,
      githubAppId: 12345,
      githubAppPrivateKeyPem: await appPrivateKeyPem(),
      repositoryBindings: {
        async getByRepositoryId() {
          return null;
        },
      },
      accessProvider: h.accessProvider,
      gatewayKeyRegistry: [],
      controlPlaneTimeoutMs: 100,
      now: () => NOW,
      githubFetchImpl: async () => {
        throw new Error("GitHub must not be called after an identity-key read failure");
      },
    });

    await expect(failingBroker.issue({ proof: h.proof, operation: "fetch" })).resolves.toEqual({
      status: "unavailable",
      reason: "runtime_identity_unavailable",
    });
  });

  it("aborts a stalled Control Plane read at the configured deadline", async () => {
    const h = await setup();
    const stalledControlPlane = {
      async fetch(_input: RequestInfo | URL, init?: RequestInit) {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Control Plane request must have an abort signal");
          if (signal.aborted) {
            reject(new DOMException("request aborted", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("request aborted", "AbortError")),
            { once: true },
          );
        });
      },
    } as unknown as Fetcher;
    const timedBroker = createRuntimeGitCredentialBroker({
      controlPlane: stalledControlPlane,
      controlPlaneGatewayAuth: GATEWAY_AUTH,
      runtimeIdentityIssuer: ISSUER,
      gatewayOrigin: GATEWAY_ORIGIN,
      githubAppId: 12345,
      githubAppPrivateKeyPem: await appPrivateKeyPem(),
      repositoryBindings: {
        async getByRepositoryId() {
          return null;
        },
      },
      accessProvider: h.accessProvider,
      gatewayKeyRegistry: [],
      controlPlaneTimeoutMs: 10,
      now: () => NOW,
      githubFetchImpl: async () => {
        throw new Error("GitHub must not be called after a Control Plane timeout");
      },
    });

    await expect(timedBroker.issue({ proof: h.proof, operation: "fetch" })).resolves.toEqual({
      status: "unavailable",
      reason: "runtime_identity_unavailable",
    });
  });

  it("requires an active current binding before asking GitHub for an installation token", async () => {
    const h = await setup();
    const noBindingControlPlane = {
      async fetch(input: RequestInfo | URL) {
        const url = String(input);
        if (url.endsWith("/.well-known/runtime-identity-jwks.json")) {
          return Response.json(h.runtimeJwks);
        }
        return new Response(null, { status: 404 });
      },
    } as unknown as Fetcher;
    const broker = createRuntimeGitCredentialBroker({
      controlPlane: noBindingControlPlane,
      controlPlaneGatewayAuth: GATEWAY_AUTH,
      runtimeIdentityIssuer: ISSUER,
      gatewayOrigin: GATEWAY_ORIGIN,
      githubAppId: 12345,
      githubAppPrivateKeyPem: await appPrivateKeyPem(),
      repositoryBindings: {
        async getByRepositoryId() {
          throw new Error("Repository binding lookup is reached only after current runtime binding");
        },
      },
      accessProvider: h.accessProvider,
      gatewayKeyRegistry: [],
      now: () => NOW,
      githubFetchImpl: async () => {
        throw new Error("GitHub must not be called for a stale runtime");
      },
    });

    await expect(broker.issue({ proof: h.proof, operation: "fetch" })).resolves.toEqual({
      status: "denied",
      reason: "runtime_binding_stale",
    });
  });

  it("verifies a Gateway publish receipt and rechecks current GitHub write authority", async () => {
    const accessProvider: FreshRepositoryAccessChecker = {
      checkBoundAccess: vi.fn(async (_userId, repositoryId, instanceId, runtimeEpoch, now) => ({
        status: "allowed" as const,
        repositoryId,
        installationId: INSTALLATION_ID,
        instanceId,
        runtimeEpoch,
        authorizationRevision: 8,
        origin: "https://ins-01arz3ndektsv4rrffq69g5fav.instances.example",
        permissions: ["read", "write"] as const,
        checkedAt: Date.parse(now),
        expiresAt: Date.parse(now) + 30_000,
      })),
    };
    const githubFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { permissions: { contents: string } };
      expect(body.permissions.contents).toBe("write");
      return Response.json({
        token: "ghs-write-installation-token",
        expires_at: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
        permissions: { contents: "write" },
        repositories: [{ id: REPOSITORY_ID }],
      });
    });
    const h = await setup({ accessProvider, githubFetchImpl: githubFetch });
    const operationId = "op_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const payloadDigest = `sha256:${"a".repeat(64)}`;
    const receipt = await issueMutationAuthorizationReceipt(
      { kid: "gateway-key-1", privateKey: h.receiptPair.privateKey },
      {
        issuer: GATEWAY_ORIGIN,
        audience: "praetorium-git-publisher",
        subjectUserId: "github-user-77",
        repositoryId: REPOSITORY_ID,
        instanceId: INSTANCE_ID,
        runtimeEpoch: RUNTIME_EPOCH,
        operationId,
        payloadDigest,
        authorizationRevision: 8,
        sessionRevision: 3,
        now: NOW.toISOString(),
        ttlSeconds: 30,
        tokenId: "publish-receipt-1",
      },
    );

    await expect(
      h.broker.issue({
        proof: h.proof,
        operation: "publish",
        mutationReceipt: receipt.token,
        operationId,
        payloadDigest,
      }),
    ).resolves.toMatchObject({
      status: "issued",
      credential: { token: "ghs-write-installation-token", permission: "write" },
    });
    expect(accessProvider.checkBoundAccess).toHaveBeenCalledWith(
      "github-user-77",
      REPOSITORY_ID,
      INSTANCE_ID,
      RUNTIME_EPOCH,
      NOW.toISOString(),
    );
    expect(githubFetch).toHaveBeenCalledTimes(1);
  });
});
