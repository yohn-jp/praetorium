import {
  createMutationAuthorizationReceiptVerifier,
  createHandoffCode,
  createSession,
  keyedDigest,
  issueAccessToken,
  ok,
  type GitHubOAuthProvider,
  type KeyRecord,
  type UserId,
} from "@praetorium/auth";
import type { AccessDecision } from "@praetorium/contracts";
import { describe, expect, it, vi } from "vitest";
import { createGatewayRouter } from "../src/router.js";
import type { GatewayContext } from "../src/context.js";
import {
  createInMemoryAccessRefreshCredentialStore,
  createInMemoryHandoffCodeStore,
  createInMemoryLoginAttemptStore,
  createInMemorySessionStore,
} from "@praetorium/auth/testing";

const NOW = "2026-10-17T03:00:00.000Z";
const ORIGIN = "https://gateway.service.test";
const REPOSITORY_ID = 482_901;
const INSTANCE_ID = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OPERATION_ID = "op_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAYLOAD_DIGEST = `sha256:${"a".repeat(64)}`;
const USER_ID = "1234567" as UserId;

function repositorySnapshot(configured = false, ready = true) {
  const binding = {
    repositoryId: REPOSITORY_ID,
    instanceId: INSTANCE_ID,
    installationId: 83_104,
    owner: "service-owner",
    name: "private-workspace",
    authorizationRevision: 9,
    bindingEpoch: 3,
    suspended: false,
  };
  const instance = {
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    generation: 5,
    runtimeEpoch: 7,
    desiredState: (ready ? "running" : "stopped") as "running" | "stopped",
    policy: "stable" as const,
    observedGeneration: 5,
    currentArtifactDigest: ready && configured ? `sha256:${"d".repeat(64)}` : null,
    desiredArtifactDigest: configured ? `sha256:${"b".repeat(64)}` : null,
    observedState: (ready ? "ready" : "stopped") as "ready" | "stopped",
    observedRuntimeEpoch: ready ? 7 : null,
    observedSequence: 1,
    desiredRevisionId: null,
    observedRevisionId: null,
    reservationState: "reserved" as const,
    reservationId: "res_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    createdAt: Date.parse(NOW),
    updatedAt: Date.parse(NOW),
  };
  return { binding, instance };
}

async function setup(options: {
  write?: boolean;
  revision?: number;
  provider?: GitHubOAuthProvider;
  onCredentialStore?: () => void;
  configured?: boolean;
  ready?: boolean;
  pendingConfiguration?: boolean;
  sourceLimiterAllowed?: boolean;
  credentialBroker?: Exclude<Awaited<ReturnType<GatewayContext["getGitHubCredentialBroker"]>>, undefined>;
} = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = "gateway-test-key";
  const keyRegistry: KeyRecord[] = [{
    kid,
    status: "active",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! },
    createdAt: NOW,
    retiredAt: null,
  }];
  const signingKey = { kid, privateKey: pair.privateKey };
  const sessionPepper = new TextEncoder().encode("mutation-test-session-pepper");
  const sessionStore = createInMemorySessionStore();
  const loginAttemptStore = createInMemoryLoginAttemptStore();
  const created = await createSession(sessionStore, {
    userId: USER_ID,
    authenticationContext: "github-oauth",
    now: NOW,
    ttlSeconds: 3_600,
    pepper: sessionPepper,
    concurrentSessionLimit: 3,
  });
  if (!created.ok) throw new Error("test session setup failed");
  const csrfToken = await keyedDigest(sessionPepper, `csrf:${created.value.rawSessionId}`);
  const baseSnapshot = repositorySnapshot(options.configured, options.ready !== false);
  const snapshot = options.pendingConfiguration
    ? {
        ...baseSnapshot,
        instance: {
          ...baseSnapshot.instance,
          generation: baseSnapshot.instance.generation + 1,
          runtimeEpoch: baseSnapshot.instance.runtimeEpoch + 1,
          observedGeneration: baseSnapshot.instance.generation,
          currentArtifactDigest: `sha256:${"c".repeat(64)}`,
          desiredArtifactDigest: baseSnapshot.instance.desiredArtifactDigest,
          observedState: "ready" as const,
          observedRuntimeEpoch: baseSnapshot.instance.runtimeEpoch,
        },
      }
    : baseSnapshot;
  const repository = {
    repositoryId: REPOSITORY_ID,
    installationId: snapshot.binding.installationId,
    owner: snapshot.binding.owner,
    name: snapshot.binding.name,
    private: true,
    role: "write" as const,
  };
  const wakeResult = options.ready === false
    ? {
      ...snapshot,
      instance: { ...snapshot.instance, desiredState: "running" as const, observedState: "starting" as const, observedGeneration: null, observedRuntimeEpoch: null },
      operation: {
        id: "op_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        instanceId: INSTANCE_ID,
        generation: 5,
        runtimeEpoch: 7,
        kind: "start",
        status: "pending",
        phase: "waiting for runtime reservation",
        attempt: 1,
        createdAt: Date.parse(NOW),
        updatedAt: Date.parse(NOW),
      },
      replayed: false,
    }
    : { ...snapshot, operation: null, replayed: false };
  let accessChecks = 0;
  let repositoryReads = 0;
  let instanceReads = 0;
  let desiredRequests = 0;
  const mutationRateLimitKeys: string[] = [];
  const sourceRateLimitKeys: string[] = [];
  const wakeRateLimitKeys: string[] = [];
  const checkedRuntimeEpochs: number[] = [];
  let writeAllowed = options.write ?? true;
  let authorizationRevision = options.revision ?? snapshot.binding.authorizationRevision;
  const access = {
    async listRepositories() { return ok(options.configured ? [repository] : []); },
    async authorize(_userId: string, _repositoryId: number, action: "read" | "write" | "maintain"): Promise<AccessDecision> {
      const permissions = options.configured ? ["read", "write"] as const : [];
      return {
        allowed: options.configured === true && (action === "read" || action === "write"),
        permissions,
        checkedAt: Date.parse(NOW),
        expiresAt: Date.parse(NOW) + 25_000,
        installationId: snapshot.binding.installationId,
        repositoryId: REPOSITORY_ID,
      };
    },
    async checkBoundAccess(_userId: string, repositoryId: number, instanceId: string, runtimeEpoch: number, now: string) {
      accessChecks += 1;
      checkedRuntimeEpochs.push(runtimeEpoch);
      if (!writeAllowed) return { status: "denied" as const };
      return {
        status: "allowed" as const,
        repositoryId,
        installationId: snapshot.binding.installationId,
        instanceId,
        origin: `https://ins-${INSTANCE_ID.slice(4).toLowerCase()}.instances.service.test`,
        runtimeEpoch,
        authorizationRevision,
        permissions: ["read", "write"] as const,
        checkedAt: Date.parse(now),
        expiresAt: Date.parse(now) + 25_000,
      };
    },
  };
  const controlPlane = {
    async getByRepositoryId(repositoryId: number) {
      repositoryReads += 1;
      return repositoryId === REPOSITORY_ID ? snapshot : null;
    },
    async getByInstanceId() { instanceReads += 1; return snapshot; },
    async resolveRepository() { return { ...snapshot, created: false }; },
    async requestDesiredState() {
      desiredRequests += 1;
      return wakeResult;
    },
  };
  const handoffStore = createInMemoryHandoffCodeStore();
  const accessRefreshCredentialStore = createInMemoryAccessRefreshCredentialStore();
  const context = {
    config: {
      environment: "test",
      origin: ORIGIN,
      sessionTtlSeconds: 3_600,
      handoffTtlSeconds: 60,
      accessGrantTtlSeconds: 300,
      instanceHostnameSuffix: "instances.service.test",
      allowedRepositoryOwner: "service-owner",
      githubAppId: 123,
      oauthClientId: "test-client",
      oauthClientSecret: "test-secret",
      controlPlaneSecret: "c".repeat(40),
      instanceAccessSecret: "i".repeat(40),
      sessionPepper,
      credentialPepper: new TextEncoder().encode("mutation-test-credential-pepper"),
      handoffPepper: new TextEncoder().encode("mutation-test-handoff-pepper"),
      tokenVault: {} as GatewayContext["config"]["tokenVault"],
    },
    env: {} as GatewayContext["env"],
    requestId: "gateway-test-request",
    requestNow: NOW,
    sessionStore,
    loginAttemptStore,
    mcpCredentialStore: {} as GatewayContext["mcpCredentialStore"],
    handoffStore,
    accessRefreshCredentialStore,
    tokenExchangeRateLimiter: { consume: async () => true },
    tokenExchangeSourceRateLimiter: {
      consume: async (key: string) => {
        sourceRateLimitKeys.push(key);
        return options.sourceLimiterAllowed !== false;
      },
    },
    runtimeCredentialRateLimiter: { consume: async () => true },
    loginRateLimiter: { consume: async () => true },
    wakeRateLimiter: { consume: async (key: string) => { wakeRateLimitKeys.push(key); return true; } },
    mutationReceiptRateLimiter: {
      consume: async (key: string) => {
        mutationRateLimitKeys.push(key);
        return true;
      },
    },
    githubProvider: options.provider as GatewayContext["githubProvider"],
    githubAccess: access as unknown as GatewayContext["githubAccess"],
    githubUserTokens: {
      accessTokenFor: async () => null,
      storeEncrypted: async () => options.onCredentialStore?.(),
    } as unknown as GatewayContext["githubUserTokens"],
    controlPlane: controlPlane as unknown as GatewayContext["controlPlane"],
    getKeyRegistry: async () => keyRegistry,
    getSigningKey: async () => signingKey,
    getGitHubCredentialBroker: async () => options.credentialBroker,
  } satisfies GatewayContext;
  const request = (body: unknown, overrides: { origin?: string; csrf?: string; cookie?: string } = {}) => new Request(
    `${ORIGIN}/api/repositories/${REPOSITORY_ID}/mutation-authorizations`,
    {
      method: "POST",
      headers: {
        Origin: overrides.origin ?? ORIGIN,
        Cookie: overrides.cookie ?? `__Host-praetorium_session=${created.value.rawSessionId}; __Host-praetorium_csrf=${csrfToken}`,
        "X-CSRF-Token": overrides.csrf ?? csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  return {
    router: createGatewayRouter(context),
    sessionCookie: `__Host-praetorium_session=${created.value.rawSessionId}`,
    request,
    bearerRequest: async (token: string) => new Request(
      `${ORIGIN}/api/repositories/${REPOSITORY_ID}/mutation-authorizations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ operationId: OPERATION_ID, payloadDigest: PAYLOAD_DIGEST }),
      },
    ),
    issueAccessGrant: (permissions: readonly ("read" | "write" | "maintain" | "admin")[] = ["read", "write"], runtimeEpoch = 7) =>
      issueAccessToken(signingKey, {
        issuer: ORIGIN,
        audience: `https://ins-${INSTANCE_ID.slice(4).toLowerCase()}.instances.service.test`,
        subjectUserId: USER_ID,
        instanceId: INSTANCE_ID,
        repositoryId: REPOSITORY_ID,
        runtimeEpoch,
        permissions,
        sessionRevision: created.value.record.sessionRevision,
        authorizationRevision: snapshot.binding.authorizationRevision,
        now: NOW,
        ttlSeconds: 90,
        tokenId: "access-grant-test",
      }),
    handoffStore,
    gatewaySessionDigest: created.value.digest,
    instanceAccessSecret: "i".repeat(40),
    publicKey: pair.publicKey,
    get accessChecks() { return accessChecks; },
    get repositoryReads() { return repositoryReads; },
    get instanceReads() { return instanceReads; },
    get desiredRequests() { return desiredRequests; },
    get sourceRateLimitKeys() { return sourceRateLimitKeys; },
    get wakeRateLimitKeys() { return wakeRateLimitKeys; },
    get mutationRateLimitKeys() { return mutationRateLimitKeys; },
    get checkedRuntimeEpochs() { return checkedRuntimeEpochs; },
    set writeAllowed(value: boolean) { writeAllowed = value; },
    set authorizationRevision(value: number) { authorizationRevision = value; },
    setObservedRuntimeState(value: "ready" | "stopping", epoch: number | null) {
      const instance = snapshot.instance as { observedState: "ready" | "stopping"; observedRuntimeEpoch: number | null };
      instance.observedState = value;
      instance.observedRuntimeEpoch = epoch;
    },
  };
}

describe("Gateway mutation authorization endpoint", () => {
  it("blocks rotating invalid MCP bearer attempts by source before touching Control Plane", async () => {
    const test = await setup({ sourceLimiterAllowed: false });
    for (const bearer of ["invalid-first", "invalid-second"]) {
      const response = await test.router.fetch(new Request(`${ORIGIN}/api/token`, {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.42",
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ repositoryId: REPOSITORY_ID, instanceId: INSTANCE_ID, runtimeEpoch: 7, permissions: ["read"] }),
      }));
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    }
    expect(test.sourceRateLimitKeys).toEqual(["203.0.113.42", "203.0.113.42"]);
    expect(test.instanceReads).toBe(0);
  });

  it("fails closed instead of pooling an absent source into an unknown MCP bucket", async () => {
    const test = await setup();
    const response = await test.router.fetch(new Request(`${ORIGIN}/api/token`, {
      method: "POST",
      headers: { Authorization: "Bearer invalid", "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryId: REPOSITORY_ID, instanceId: INSTANCE_ID, runtimeEpoch: 7, permissions: ["read"] }),
    }));
    expect(response.status).toBe(503);
    expect(test.sourceRateLimitKeys).toEqual([]);
    expect(test.instanceReads).toBe(0);
  });

  it("redirects legacy GET action URLs to the dashboard without portal activity", async () => {
    const test = await setup();
    const response = await test.router.fetch(new Request(
      `${ORIGIN}/repositories/${REPOSITORY_ID}/actions?ui=mobile&poll=3`,
    ));
    const location = response.headers.get("location");

    expect(response.status).toBe(303);
    expect(location).not.toBeNull();
    expect(new URL(location!, ORIGIN).pathname).toBe(`/repositories/${REPOSITORY_ID}`);
    expect(new URL(location!, ORIGIN).search).toBe("?ui=mobile&poll=3");
    expect(test.repositoryReads).toBe(0);
    expect(test.accessChecks).toBe(0);
    expect(test.desiredRequests).toBe(0);
  });

  it("routes runtime Git credential issuance only through an explicitly configured broker", async () => {
    const valid = {
      operation: "fetch",
      proof: {
        serviceToken: "runtime-service-token-long-enough",
        runtimeId: "runtime-1",
        instanceId: INSTANCE_ID,
        repositoryId: REPOSITORY_ID,
        installationId: 83_104,
        runtimeEpoch: 7,
        leaseId: "lease-1",
      },
    };
    const missingAdapter = await setup();
    const unavailable = await missingAdapter.router.fetch(new Request(`${ORIGIN}/internal/github/credential`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(valid),
    }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("token");

    let receivedOperation = "";
    const configured = await setup({
      credentialBroker: {
        async issue(input) {
          receivedOperation = input.operation;
          return {
            status: "issued",
            credential: {
              username: "x-access-token",
              token: "one-repository-scoped-token",
              repositoryId: REPOSITORY_ID,
              permission: "read",
              runtimeEpoch: 7,
              expiresAt: "2026-10-17T03:05:00.000Z",
            },
          };
        },
      },
    });
    const issued = await configured.router.fetch(new Request(`${ORIGIN}/internal/github/credential`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(valid),
    }));
    expect(issued.status).toBe(200);
    expect(receivedOperation).toBe("fetch");
    expect(await issued.json()).toMatchObject({ repositoryId: REPOSITORY_ID, runtimeEpoch: 7 });

    const unknownOperation = await configured.router.fetch(new Request(`${ORIGIN}/internal/github/credential`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...valid, operation: "push" }),
    }));
    expect(unknownOperation.status).toBe(400);
    expect(receivedOperation).toBe("fetch");
  });

  it("logs only allowlisted runtime Git broker rejection reasons", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = JSON.stringify({
      operation: "fetch",
      proof: {
        serviceToken: "runtime-service-token-long-enough",
        runtimeId: "runtime-1",
        instanceId: INSTANCE_ID,
        repositoryId: REPOSITORY_ID,
        installationId: 83_104,
        runtimeEpoch: 7,
        leaseId: "lease-1",
      },
    });
    const requestForReason = async (reason: string) => {
      const test = await setup({
        credentialBroker: {
          async issue() {
            return { status: "denied", reason };
          },
        },
      });
      return test.router.fetch(new Request(`${ORIGIN}/internal/github/credential`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }));
    };
    try {
      const response = await requestForReason("repository_binding_stale");
      expect(response.status).toBe(401);
      expect(warning).toHaveBeenCalledWith(JSON.stringify({
        event: "runtime_git_credential_rejected",
        status: "denied",
        reason: "repository_binding_stale",
      }));

      await requestForReason("private-token-value");
      expect(warning).toHaveBeenLastCalledWith(JSON.stringify({
        event: "runtime_git_credential_rejected",
        status: "denied",
        reason: "unknown",
      }));
      expect(warning.mock.calls.flat().join(" ")).not.toContain("private-token-value");
    } finally {
      warning.mockRestore();
    }
  });

  it("rejects duplicate host-only session and CSRF cookie names", async () => {
    const test = await setup();
    const duplicateSession = await test.router.fetch(new Request(`${ORIGIN}/api/session`, {
      headers: { Cookie: `${test.sessionCookie}; __Host-praetorium_session=attacker-value` },
    }));
    const duplicateCsrf = await test.router.fetch(test.request(
      { operationId: OPERATION_ID, payloadDigest: PAYLOAD_DIGEST },
      { cookie: `${test.sessionCookie}; __Host-praetorium_csrf=first; __Host-praetorium_csrf=second` },
    ));
    const mixedSessionAndBearer = await test.router.fetch(new Request(`${ORIGIN}/api/token`, {
      method: "POST",
      headers: {
        Authorization: "Bearer one-time-mcp-credential",
        Cookie: `${test.sessionCookie}; __Host-praetorium_session=attacker-value`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repositoryId: REPOSITORY_ID,
        instanceId: INSTANCE_ID,
        runtimeEpoch: 7,
        permissions: ["read"],
      }),
    }));

    expect(duplicateSession.status).toBe(401);
    expect(duplicateCsrf.status).toBe(403);
    expect(mixedSessionAndBearer.status).toBe(401);
    expect(test.accessChecks).toBe(0);
  });

  it("rejects a host that does not match the trusted instance ID before checking access", async () => {
    const test = await setup();
    const response = await test.router.fetch(new Request(`${ORIGIN}/internal/instance-access/handoff`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${"i".repeat(40)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contractVersion: "instance-access/v1",
        audience: "instance-access",
        instanceId: INSTANCE_ID,
        hostname: "ins-01arz3ndektsv4rrffq69g5fav.attacker.test",
        origin: "https://ins-01arz3ndektsv4rrffq69g5fav.attacker.test",
        code: "single-use-handoff-code",
        returnPath: "/",
      }),
    }));

    expect(response.status).toBe(400);
    expect(test.accessChecks).toBe(0);
    expect(test.repositoryReads).toBe(0);
  });

  it("issues a short-lived signed receipt from the session and current write authority only", async () => {
    const test = await setup();
    const response = await test.router.fetch(test.request({ operationId: OPERATION_ID, payloadDigest: PAYLOAD_DIGEST }));
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json() as { receipt: string; operationId: string; payloadDigest: string; expiresAt: string };
    expect(body.operationId).toBe(OPERATION_ID);
    expect(body.payloadDigest).toBe(PAYLOAD_DIGEST);
    expect(Date.parse(body.expiresAt) - Date.parse(NOW)).toBeLessThanOrEqual(25_000);

    const verifier = createMutationAuthorizationReceiptVerifier({
      issuer: ORIGIN,
      audience: "praetorium-git-publisher",
      resolveKey: async (kid) => kid === "gateway-test-key" ? test.publicKey : null,
    });
    const verified = await verifier.verify(body.receipt, {
      repositoryId: REPOSITORY_ID,
      instanceId: INSTANCE_ID,
      runtimeEpoch: 7,
      operationId: OPERATION_ID,
      payloadDigest: PAYLOAD_DIGEST,
      now: NOW,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.value.sub).toBe(USER_ID);
      expect(verified.value.authorizationRevision).toBe(9);
      expect(verified.value.sessionRevision).toBe(0);
      expect(verified.value.action).toBe("publish");
    }
    expect(test.accessChecks).toBe(1);
    expect(test.repositoryReads).toBe(1);
  });

  it("issues a publish receipt for a current Hosted bearer grant without Gateway cookies", async () => {
    const test = await setup({ configured: true });
    const token = await test.issueAccessGrant();
    const response = await test.router.fetch(await test.bearerRequest(token));
    expect(response.status).toBe(201);
    const body = await response.json() as { receipt: string };
    const verifier = createMutationAuthorizationReceiptVerifier({
      issuer: ORIGIN,
      audience: "praetorium-git-publisher",
      resolveKey: async (kid) => kid === "gateway-test-key" ? test.publicKey : null,
    });
    const receipt = await verifier.verify(body.receipt, {
      repositoryId: REPOSITORY_ID,
      instanceId: INSTANCE_ID,
      runtimeEpoch: 7,
      operationId: OPERATION_ID,
      payloadDigest: PAYLOAD_DIGEST,
      now: NOW,
    });
    expect(receipt.ok).toBe(true);
    if (receipt.ok) {
      expect(receipt.value.sub).toBe(USER_ID);
      expect(receipt.value.sessionRevision).toBe(0);
    }
    expect(test.accessChecks).toBe(1);
  });

  it("rejects read-only or stale Hosted grants and rechecks current write access", async () => {
    const test = await setup({ configured: true });
    const readOnly = await test.issueAccessGrant(["read"]);
    expect((await test.router.fetch(await test.bearerRequest(readOnly))).status).toBe(401);
    const staleEpoch = await test.issueAccessGrant(["read", "write"], 6);
    expect((await test.router.fetch(await test.bearerRequest(staleEpoch))).status).toBe(401);
    const current = await test.issueAccessGrant();
    test.writeAllowed = false;
    expect((await test.router.fetch(await test.bearerRequest(current))).status).toBe(403);
    expect(test.accessChecks).toBe(1);
  });

  it("charges mutation rate limits only to a verified user and repository", async () => {
    const test = await setup({ configured: true });
    const invalid = await test.router.fetch(await test.bearerRequest("bad.token.value"));
    expect(invalid.status).toBe(401);
    expect(test.mutationRateLimitKeys).toEqual([]);

    const valid = await test.router.fetch(await test.bearerRequest(await test.issueAccessGrant()));
    expect(valid.status).toBe(201);
    expect(test.mutationRateLimitKeys).toEqual([`${USER_ID}:${REPOSITORY_ID}`]);
  });

  it("redeems, rotates and revokes the stable-origin grant through service-authenticated routes", async () => {
    const test = await setup({ pendingConfiguration: true });
    const host = `ins-${INSTANCE_ID.slice(4).toLowerCase()}.instances.service.test`;
    const origin = `https://${host}`;
    const created = await createHandoffCode(test.handoffStore, {
      userId: USER_ID,
      gatewaySessionDigest: test.gatewaySessionDigest,
      repositoryId: REPOSITORY_ID,
      instanceId: INSTANCE_ID,
      runtimeEpoch: 7,
      hostname: host,
      origin,
      audience: "instance-access",
      returnPath: "/",
      requestedPermissions: ["read", "write"],
      now: NOW,
      ttlSeconds: 60,
      pepper: new TextEncoder().encode("mutation-test-handoff-pepper"),
    });
    const serviceHeaders = {
      Authorization: `Bearer ${test.instanceAccessSecret}`,
      "Content-Type": "application/json",
    };
    const base = {
      contractVersion: "instance-access/v1",
      audience: "instance-access",
      instanceId: INSTANCE_ID,
      hostname: host,
      origin,
    };
    const redeemed = await test.router.fetch(new Request(`${ORIGIN}/internal/instance-access/handoff`, {
      method: "POST",
      headers: serviceHeaders,
      body: JSON.stringify({ ...base, code: created.rawCode, returnPath: "/" }),
    }));
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.get("Cache-Control")).toBe("no-store");
    const initial = await redeemed.json() as {
      token: string;
      expiresAt: string;
      refreshCredential: string;
      refreshExpiresAt: string;
    };
    expect(initial.token).toMatch(/^eyJ/);
    expect(Date.parse(initial.expiresAt)).toBeGreaterThan(Date.parse(NOW));
    expect(Date.parse(initial.refreshExpiresAt)).toBe(Date.parse(NOW) + 3_600_000);

    const refresh = (refreshCredential: string) => new Request(`${ORIGIN}/internal/instance-access/refresh`, {
      method: "POST",
      headers: serviceHeaders,
      body: JSON.stringify({ ...base, refreshCredential }),
    });
    const rotatedResponse = await test.router.fetch(refresh(initial.refreshCredential));
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as typeof initial;
    expect(rotated.refreshCredential).not.toBe(initial.refreshCredential);
    expect((await test.router.fetch(refresh(initial.refreshCredential))).status).toBe(401);

    const revoked = await test.router.fetch(new Request(`${ORIGIN}/internal/instance-access/revoke`, {
      method: "POST",
      headers: serviceHeaders,
      body: JSON.stringify({ ...base, refreshCredential: rotated.refreshCredential }),
    }));
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ contractVersion: "instance-access/v1", revoked: true });
    expect((await test.router.fetch(refresh(rotated.refreshCredential))).status).toBe(401);
  });

  it("stops refreshing the old runtime grant once observation leaves the current ready runtime", async () => {
    const test = await setup({ pendingConfiguration: true });
    const host = `ins-${INSTANCE_ID.slice(4).toLowerCase()}.instances.service.test`;
    const origin = `https://${host}`;
    const created = await createHandoffCode(test.handoffStore, {
      userId: USER_ID,
      gatewaySessionDigest: test.gatewaySessionDigest,
      repositoryId: REPOSITORY_ID,
      instanceId: INSTANCE_ID,
      runtimeEpoch: 7,
      hostname: host,
      origin,
      audience: "instance-access",
      returnPath: "/",
      requestedPermissions: ["read"],
      now: NOW,
      ttlSeconds: 60,
      pepper: new TextEncoder().encode("mutation-test-handoff-pepper"),
    });
    const headers = {
      Authorization: `Bearer ${"i".repeat(40)}`,
      "Content-Type": "application/json",
    };
    const binding = {
      contractVersion: "instance-access/v1",
      audience: "instance-access",
      instanceId: INSTANCE_ID,
      hostname: host,
      origin,
    };
    const redeemed = await test.router.fetch(new Request(`${ORIGIN}/internal/instance-access/handoff`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...binding, code: created.rawCode, returnPath: "/" }),
    }));
    expect(redeemed.status).toBe(200);
    const grant = await redeemed.json() as { refreshCredential: string };

    test.setObservedRuntimeState("stopping", 7);
    const refresh = await test.router.fetch(new Request(`${ORIGIN}/internal/instance-access/refresh`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...binding, refreshCredential: grant.refreshCredential }),
    }));

    expect(refresh.status).toBe(401);
  });

  it("rejects cross-origin, bad-CSRF, caller-actor and non-write requests before receipt issuance", async () => {
    const test = await setup();
    const validBody = { operationId: OPERATION_ID, payloadDigest: PAYLOAD_DIGEST };
    const crossOrigin = await test.router.fetch(test.request(validBody, { origin: "https://attacker.service.test" }));
    const badCsrf = await test.router.fetch(test.request(validBody, { csrf: "wrong" }));
    const callerActor = await test.router.fetch(test.request({ ...validBody, actorId: "999999" }));
    test.writeAllowed = false;
    const noWrite = await test.router.fetch(test.request(validBody));
    expect(crossOrigin.status).toBe(403);
    expect(badCsrf.status).toBe(403);
    expect(callerActor.status).toBe(400);
    expect(noWrite.status).toBe(403);
  });

  it("refuses stale authorization revisions without trusting posted state", async () => {
    const test = await setup();
    test.authorizationRevision = 8;
    const response = await test.router.fetch(test.request({ operationId: OPERATION_ID, payloadDigest: PAYLOAD_DIGEST }));
    expect(response.status).toBe(403);
  });

  it("uses the configured Gateway origin and strips nested query secrets from login redirects", async () => {
    const test = await setup();
    const response = await test.router.fetch(new Request(
      `https://attacker.test/repositories/${REPOSITORY_ID}?access_token=secret-value&state=private-state`,
      { headers: { Accept: "text/html" } },
    ));
    const location = new URL(response.headers.get("Location")!);
    expect(response.status).toBe(302);
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/auth/github/start");
    expect(location.searchParams.get("redirect_to")).toBe(`/repositories/${REPOSITORY_ID}`);
    expect(response.headers.get("Location")).not.toContain("secret-value");
    expect(response.headers.get("Location")).not.toContain("private-state");
  });

  it("only opens a repository from a top-level document navigation", async () => {
    const test = await setup({ configured: true });
    const response = await test.router.fetch(new Request(`${ORIGIN}/entry/${INSTANCE_ID}`, {
      headers: {
        Cookie: test.sessionCookie,
        Accept: "image/png",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Dest": "image",
      },
    }));
    expect(response.status).toBe(400);
    expect(test.repositoryReads).toBe(0);
    expect(test.accessChecks).toBe(0);
    expect(test.desiredRequests).toBe(0);
  });

  it("routes a direct bookmark to configuration guidance without waking an unconfigured instance", async () => {
    const test = await setup();
    const response = await test.router.fetch(new Request(`${ORIGIN}/entry/${INSTANCE_ID}`, {
      headers: { Cookie: test.sessionCookie, Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
    }));
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Configuration required");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(test.desiredRequests).toBe(0);
  });

  it("wakes a configured stopped instance once, shows wait state, and never redirects with a code", async () => {
    const test = await setup({ configured: true, ready: false });
    const response = await test.router.fetch(new Request(`${ORIGIN}/entry/${INSTANCE_ID}`, {
      headers: { Cookie: test.sessionCookie, Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
    }));
    expect(response.status).toBe(202);
    expect(response.headers.get("Retry-After")).toBe("5");
    const html = await response.text();
    expect(html).toContain("waiting for runtime reservation");
    expect(html).toContain("op_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(html).toContain('http-equiv="refresh" content="5; url=/entry/ins_01ARZ3NDEKTSV4RRFFQ69G5FAV?poll=1"');
    expect(response.headers.get("Location")).toBeNull();
    expect(test.desiredRequests).toBe(1);
    expect(test.wakeRateLimitKeys).toEqual([`${USER_ID}:${REPOSITORY_ID}`]);
  });

  it("stops direct-entry automatic polling after five refreshes", async () => {
    const test = await setup({ configured: true, ready: false });
    const response = await test.router.fetch(new Request(`${ORIGIN}/entry/${INSTANCE_ID}?poll=5`, {
      headers: { Cookie: test.sessionCookie, Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
    }));

    expect(response.status).toBe(202);
    expect(await response.text()).not.toContain("http-equiv=\"refresh\"");
    expect(test.desiredRequests).toBe(1);
  });

  it("hands a ready configured repository to its exact stable HTTPS host by body-only POST", async () => {
    const test = await setup({ configured: true });
    const response = await test.router.fetch(new Request(`${ORIGIN}/entry/${INSTANCE_ID}`, {
      headers: { Cookie: test.sessionCookie, Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
    }));
    const host = `https://ins-${INSTANCE_ID.slice(4).toLowerCase()}.instances.service.test`;
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain(`form-action ${host}`);
    expect(response.headers.get("Location")).toBeNull();
    const html = await response.text();
    expect(html).toContain(`action="${host}/_platform/handoff"`);
    expect(html).toContain('name="code" value="');
    expect(html).not.toContain("Location:");
    expect(test.desiredRequests).toBe(0);
    expect(test.wakeRateLimitKeys).toEqual([]);
  });

  it("keeps a ready current runtime on its observed epoch while a desired build is pending", async () => {
    const test = await setup({ configured: true, pendingConfiguration: true });
    const response = await test.router.fetch(new Request(`${ORIGIN}/entry/${INSTANCE_ID}`, {
      headers: { Cookie: test.sessionCookie, Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
    }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('name="code" value="');
    expect(test.desiredRequests).toBe(0);
    expect(test.checkedRuntimeEpochs).toEqual([7, 7, 7]);
    expect(test.wakeRateLimitKeys).toEqual([]);
  });

  it("binds the OAuth callback to a short-lived host-only browser nonce and clears it on every outcome", async () => {
    let exchanges = 0;
    let storedCredentials = 0;
    const provider: GitHubOAuthProvider = {
      buildAuthorizeUrl({ state }) {
        return `https://github.com/login/oauth/authorize?state=${encodeURIComponent(state)}`;
      },
      async exchangeCode() {
        exchanges += 1;
        return ok({ accessToken: "transient-github-access-token", refreshToken: "transient-refresh-token" });
      },
      async fetchProfile() {
        return ok({ subject: "1234567", login: "service-owner", verifiedEmail: null, suspended: false });
      },
    };
    const test = await setup({ provider, onCredentialStore: () => { storedCredentials += 1; } });
    const start = await test.router.fetch(new Request(`${ORIGIN}/auth/github/start?redirect_to=%2Frepositories%2F${REPOSITORY_ID}`, { headers: { "CF-Connecting-IP": "203.0.113.42" } }));
    expect(start.status).toBe(302);
    expect(start.headers.get("Location")).toContain("https://github.com/login/oauth/authorize?");
    const nonceCookie = start.headers.get("Set-Cookie") ?? "";
    expect(nonceCookie).toContain("Secure");
    expect(nonceCookie).toContain("HttpOnly");
    expect(nonceCookie).toContain("SameSite=Lax");
    expect(nonceCookie).toContain("Path=/");
    expect(nonceCookie).toContain("Max-Age=300");
    expect(nonceCookie).not.toContain("Domain=");
    const nonce = /__Host-praetorium_login_nonce=([^;]+)/u.exec(nonceCookie)?.[1];
    const state = new URL(start.headers.get("Location")!).searchParams.get("state");
    expect(nonce).toBeTruthy();
    expect(state).toBeTruthy();

    const badNonce = nonce?.startsWith("A") ? `B${nonce.slice(1)}` : `A${nonce?.slice(1) ?? ""}`;
    const denied = await test.router.fetch(new Request(`${ORIGIN}/auth/github/callback?state=${state}&code=code-1`, {
      headers: { Cookie: `__Host-praetorium_login_nonce=${badNonce}` },
    }));
    expect(denied.status).toBe(401);
    expect(denied.headers.getSetCookie().some((value) => value.startsWith("__Host-praetorium_login_nonce=") && value.includes("Max-Age=0"))).toBe(true);
    expect(exchanges).toBe(0);
    expect(storedCredentials).toBe(0);

    const duplicateStart = await test.router.fetch(new Request(`${ORIGIN}/auth/github/start`, { headers: { "CF-Connecting-IP": "203.0.113.42" } }));
    const duplicateCookie = duplicateStart.headers.get("Set-Cookie") ?? "";
    const duplicateNonce = /__Host-praetorium_login_nonce=([^;]+)/u.exec(duplicateCookie)?.[1];
    const duplicateState = new URL(duplicateStart.headers.get("Location")!).searchParams.get("state");
    const duplicate = await test.router.fetch(new Request(`${ORIGIN}/auth/github/callback?state=${duplicateState}&code=code-duplicate`, {
      headers: { Cookie: `__Host-praetorium_login_nonce=${duplicateNonce}; __Host-praetorium_login_nonce=attacker-value` },
    }));
    expect(duplicate.status).toBe(401);
    expect(duplicate.headers.getSetCookie().some((value) => value.startsWith("__Host-praetorium_login_nonce=") && value.includes("Max-Age=0"))).toBe(true);
    expect(exchanges).toBe(0);
    expect(storedCredentials).toBe(0);

    const successStart = await test.router.fetch(new Request(`${ORIGIN}/auth/github/start?redirect_to=%2Frepositories%2F${REPOSITORY_ID}`, { headers: { "CF-Connecting-IP": "203.0.113.42" } }));
    const successCookie = successStart.headers.get("Set-Cookie") ?? "";
    const successNonce = /__Host-praetorium_login_nonce=([^;]+)/u.exec(successCookie)?.[1];
    const successState = new URL(successStart.headers.get("Location")!).searchParams.get("state");
    const success = await test.router.fetch(new Request(`${ORIGIN}/auth/github/callback?state=${successState}&code=code-2`, {
      headers: { Cookie: `__Host-praetorium_login_nonce=${successNonce}` },
    }));
    expect(success.status).toBe(303);
    expect(success.headers.get("Location")).toBe(`/repositories/${REPOSITORY_ID}`);
    const successCookies = success.headers.getSetCookie();
    expect(successCookies.some((value) => value.startsWith("__Host-praetorium_login_nonce=") && value.includes("Max-Age=0"))).toBe(true);
    const sessionCookie = successCookies.find((value) => value.startsWith("__Host-praetorium_session="));
    const csrfCookie = successCookies.find((value) => value.startsWith("__Host-praetorium_csrf="));
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Path=/");
    expect(csrfCookie).toContain("Secure");
    expect(csrfCookie).toContain("Path=/");
    expect(csrfCookie).not.toContain("HttpOnly");
    expect(successCookies.join("\n")).not.toContain("Domain=");
    expect((await success.text())).not.toContain("transient-github-access-token");
    expect(exchanges).toBe(1);
    expect(storedCredentials).toBe(1);
  });
});
