import { describe, expect, it, vi } from "vitest";
import { verifyAccessToken } from "@praetorium/auth";
import { AccessGrantSchema, applicationHostname, physicalInstanceId } from "@praetorium/contracts";
import type { GatewayContext } from "../src/context.js";
import { createRuntimeAuthProbeRoutes } from "../src/runtime-auth-probes.js";

const ORIGIN = "https://gateway.service.test";
const CONTROL_SECRET = "history-drain-control-plane-secret".padEnd(48, "s");
const OPERATION_ID = "op_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ACTOR_ID = "1234567";
const REPOSITORY_ID = 482_901;
const INSTANCE_ID = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = new Date().toISOString();
const OLD_GENERATION = 7;
const OLD_RUNTIME_EPOCH = 6;
const CURRENT_GENERATION = 8;
const CURRENT_RUNTIME_EPOCH = 7;

function snapshot(
  overrides: {
    binding?: Record<string, unknown>;
    instance?: Record<string, unknown>;
  } = {},
) {
  return {
    binding: {
      appIdentity: "scriptorium",
      repositoryId: REPOSITORY_ID,
      instanceId: INSTANCE_ID,
      installationId: 83_104,
      owner: "service-owner",
      name: "private-workspace",
      authorizationRevision: 9,
      bindingEpoch: 3,
      suspended: false,
      ...overrides.binding,
    },
    instance: {
      instanceId: INSTANCE_ID,
      repositoryId: REPOSITORY_ID,
      generation: CURRENT_GENERATION,
      runtimeEpoch: CURRENT_RUNTIME_EPOCH,
      desiredState: "running",
      policy: "stable",
      observedGeneration: OLD_GENERATION,
      observedRuntimeEpoch: OLD_RUNTIME_EPOCH,
      observedState: "ready",
      observedSequence: 4,
      legacyRuntimeEpoch: 5,
      currentArtifactDigest: `sha256:${"a".repeat(64)}`,
      desiredArtifactDigest: `sha256:${"b".repeat(64)}`,
      desiredRevisionId: "target-revision",
      observedRevisionId: "previous-revision",
      reservationState: "reserved",
      reservationId: "res_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      clusterId: "cluster-test",
      createdAt: 1,
      updatedAt: 2,
      ...overrides.instance,
    },
  };
}

async function setup(
  options: {
    snapshots?: ReturnType<typeof snapshot>[];
    access?: Record<string, unknown>;
  } = {},
) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const getByRepositoryId = vi.fn(async () => {
    const next = options.snapshots?.shift();
    return next ?? snapshot();
  });
  const authorize = vi.fn(async () => ({
    allowed: true,
    repositoryId: REPOSITORY_ID,
    installationId: 83_104,
    permissions: ["read"],
    expiresAt: Date.parse(NOW) + 120_000,
    ...options.access,
  }));
  const context = {
    config: {
      origin: ORIGIN,
      controlPlaneSecret: CONTROL_SECRET,
      accessGrantTtlSeconds: 120,
    },
    requestNow: NOW,
    controlPlane: { getByRepositoryId },
    githubAccess: { authorize },
    getSigningKey: async () => ({ kid: "gateway-test-key", privateKey: pair.privateKey }),
  } as unknown as GatewayContext;
  const app = createRuntimeAuthProbeRoutes(context);
  const body = {
    operationId: OPERATION_ID,
    actorId: ACTOR_ID,
    repositoryId: REPOSITORY_ID,
    instanceId: INSTANCE_ID,
    authorizationRevision: 9,
    oldGeneration: OLD_GENERATION,
    oldRuntimeEpoch: OLD_RUNTIME_EPOCH,
    currentGeneration: CURRENT_GENERATION,
    currentRuntimeEpoch: CURRENT_RUNTIME_EPOCH,
  };
  const request = (authorization = CONTROL_SECRET, cookie?: string, requestBody = body) =>
    new Request(`${ORIGIN}/internal/provisioner/history-drain-grant`, {
      method: "POST",
      headers: {
        "X-Control-Plane-Gateway-Auth": authorization,
        "Content-Type": "application/json",
        ...(cookie === undefined ? {} : { Cookie: cookie }),
      },
      body: JSON.stringify(requestBody),
    });
  return { app, request, authorize, getByRepositoryId, pair, body };
}

describe("private Gateway history-drain grant", () => {
  it("issues exactly one read grant for the observed old tuple after checking the current tuple", async () => {
    const h = await setup();
    const response = await h.app.request(h.request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(Object.keys(result).sort()).toEqual(
      [
        "issuer",
        "jwksUrl",
        "origin",
        "audience",
        "authorizationRevision",
        "grant",
        "permissions",
      ].sort(),
    );
    expect(result).toMatchObject({
      issuer: ORIGIN,
      jwksUrl: `${ORIGIN}/.well-known/jwks.json`,
      origin: `https://${applicationHostname("scriptorium", REPOSITORY_ID)}`,
      audience: `https://${applicationHostname("scriptorium", REPOSITORY_ID)}`,
      authorizationRevision: 9,
      permissions: ["read"],
    });
    const verified = await verifyAccessToken({
      token: result.grant,
      expectedIssuer: ORIGIN,
      expectedAudience: result.audience,
      expectedInstanceId: physicalInstanceId(INSTANCE_ID, OLD_RUNTIME_EPOCH, 5),
      expectedRepositoryId: REPOSITORY_ID,
      expectedRuntimeEpoch: OLD_RUNTIME_EPOCH,
      requiredPermissions: ["read"],
      now: NOW,
      clockSkewSeconds: 0,
      resolveKey: async (kid) => (kid === "gateway-test-key" ? h.pair.publicKey : null),
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("history drain grant failed verification");
    expect(AccessGrantSchema.parse(verified.value)).toMatchObject({
      sub: ACTOR_ID,
      repositoryId: REPOSITORY_ID,
      runtimeEpoch: OLD_RUNTIME_EPOCH,
      permissions: ["read"],
      authorizationRevision: 9,
    });
    expect(verified.value.exp - verified.value.iat).toBeLessThanOrEqual(30);
    expect(h.authorize).toHaveBeenCalledExactlyOnceWith(ACTOR_ID, REPOSITORY_ID, "read");
    expect(h.getByRepositoryId).toHaveBeenCalledTimes(2);
  });

  it("rejects browser cookies, wrong service authority, and malformed or current tuples", async () => {
    const h = await setup();
    expect((await h.app.request(h.request("wrong-secret"))).status).toBe(401);
    expect((await h.app.request(h.request(CONTROL_SECRET, "session=browser-cookie"))).status).toBe(
      401,
    );
    expect(
      (await h.app.request(h.request(CONTROL_SECRET, undefined, { ...h.body, unexpected: true })))
        .status,
    ).toBe(400);
    const replayedTuple = {
      ...h.body,
      oldGeneration: CURRENT_GENERATION,
      oldRuntimeEpoch: CURRENT_RUNTIME_EPOCH,
    };
    expect((await h.app.request(h.request(CONTROL_SECRET, undefined, replayedTuple))).status).toBe(
      400,
    );
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it("allows repeated CP-authorized reads while each response remains read-only and short-lived", async () => {
    const h = await setup();
    const first = await h.app.request(h.request());
    const second = await h.app.request(h.request());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstGrant = (await first.json()).grant;
    const secondGrant = (await second.json()).grant;
    expect(firstGrant).not.toBe(secondGrant);
    for (const token of [firstGrant, secondGrant]) {
      const verified = await verifyAccessToken({
        token,
        expectedIssuer: ORIGIN,
        expectedAudience: `https://${applicationHostname("scriptorium", REPOSITORY_ID)}`,
        expectedInstanceId: physicalInstanceId(INSTANCE_ID, OLD_RUNTIME_EPOCH, 5),
        expectedRepositoryId: REPOSITORY_ID,
        expectedRuntimeEpoch: OLD_RUNTIME_EPOCH,
        requiredPermissions: ["read"],
        now: new Date().toISOString(),
        clockSkewSeconds: 0,
        resolveKey: async (kid) => (kid === "gateway-test-key" ? h.pair.publicKey : null),
      });
      expect(verified.ok).toBe(true);
      if (!verified.ok) throw new Error("history drain grant failed verification");
      expect(verified.value.permissions).toEqual(["read"]);
      expect(verified.value.exp - verified.value.iat).toBeLessThanOrEqual(30);
    }
    expect(h.authorize).toHaveBeenCalledTimes(2);
    expect(h.getByRepositoryId).toHaveBeenCalledTimes(4);
  });

  it("rejects expired GitHub read permission and a binding changed during revalidation", async () => {
    const expired = await setup({ access: { expiresAt: Date.parse(NOW) - 1 } });
    expect((await expired.app.request(expired.request())).status).toBe(403);

    const changed = await setup({
      snapshots: [snapshot(), snapshot({ instance: { runtimeEpoch: 8 } })],
    });
    const response = await changed.app.request(changed.request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "CURRENT_BINDING_CHANGED" } });
  });
});
