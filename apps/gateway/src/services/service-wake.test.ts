import { describe, expect, it, vi } from "vitest";
import { AccessGrantId, issueAccessGrant } from "@praetorium/auth";
import type { GatewayContext } from "../context.js";
import { requestAuthorizedServiceWake } from "./service-wake.js";

const NOW = "2026-10-21T00:00:00.000Z";
const ORIGIN = "https://482901.scriptorium.yohn.jp";
const INSTANCE = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";

async function setup(options: { ready?: boolean; denied?: boolean; noArtifact?: boolean; rateLimited?: boolean } = {}) {
  const key = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  );
  const token = await issueAccessGrant({ kid: "test-key", privateKey: key.privateKey }, {
    id: AccessGrantId.parse("agr_01JATJ2BW7D5SE60Z9RFF3DSK6"),
    issuer: "https://gateway.service.test",
    audience: ORIGIN,
    subjectUserId: "github:4242",
    repositoryId: 482901,
    audienceInstanceId: INSTANCE,
    runtimeEpoch: 7,
    permissions: ["read"],
    sessionRevision: 1,
    authorizationRevision: 9,
    now: NOW,
    ttlSeconds: 300,
  });
  const snapshot = {
    binding: { appIdentity: "scriptorium", repositoryId: 482901, instanceId: INSTANCE,
      installationId: 84, bindingEpoch: 2, authorizationRevision: 9, suspended: false },
    instance: { instanceId: INSTANCE, repositoryId: 482901, runtimeEpoch: 7,
      legacyRuntimeEpoch: undefined, observedRuntimeEpoch: options.ready ? 7 : null,
      observedState: options.ready ? "ready" : "stopped",
      desiredState: "stopped", currentArtifactDigest: options.ready ? "sha256:abc" : null,
      desiredArtifactDigest: options.noArtifact ? null : "sha256:def", generation: 5 },
  };
  const requestDesiredState = vi.fn(async () => ({}));
  const consume = vi.fn(async () => !options.rateLimited);
  const checkBoundAccess = vi.fn(async () => ({
    status: options.denied ? "denied" : "allowed", repositoryId: 482901, instanceId: INSTANCE,
    runtimeEpoch: 7, installationId: 84, authorizationRevision: 9, permissions: ["read"],
    expiresAt: Date.parse(NOW) + 60_000,
  }));
  const context = {
    config: { origin: "https://gateway.service.test" }, requestNow: NOW, requestId: "wake-test",
    getKeyRegistry: async () => [{
      kid: "test-key", status: "active", publicKeyJwk: await crypto.subtle.exportKey("jwk", key.publicKey),
    }],
    controlPlane: { getByRepositoryId: async () => snapshot, requestDesiredState },
    githubAccess: { checkBoundAccess },
    wakeRateLimiter: { consume },
  } as unknown as GatewayContext;
  const input = { appIdentity: "scriptorium" as const, repositoryId: 482901,
    origin: ORIGIN, accessGrant: token.token };
  return { context, input, requestDesiredState, consume, checkBoundAccess };
}

describe("generic service bearer wake", () => {
  it("reuses desired-state control with an exact currently authorized grant", async () => {
    const fixture = await setup();
    expect(await requestAuthorizedServiceWake(fixture.context, fixture.input)).toEqual({ status: "starting" });
    expect(fixture.checkBoundAccess).toHaveBeenCalledWith("github:4242", 482901, INSTANCE, 7, NOW);
    expect(fixture.consume).toHaveBeenCalledWith("github:4242:482901", NOW);
    expect(fixture.requestDesiredState).toHaveBeenCalledOnce();
    expect(fixture.requestDesiredState.mock.calls[0]?.[1]).toMatchObject({
      actorId: "github:4242", desiredState: "running", expectedGeneration: 5,
      bindingEpoch: 2, authorizationRevision: 9,
    });
  });

  it("rejects other audiences and unauthorized repository actors without waking", async () => {
    const fixture = await setup();
    expect(await requestAuthorizedServiceWake(fixture.context, { ...fixture.input, origin: "https://attacker.test" }))
      .toEqual({ status: "unauthorized" });
    const denied = await setup({ denied: true });
    expect(await requestAuthorizedServiceWake(denied.context, denied.input)).toEqual({ status: "unauthorized" });
    expect(fixture.requestDesiredState).not.toHaveBeenCalled();
    expect(denied.requestDesiredState).not.toHaveBeenCalled();
    expect(denied.consume).not.toHaveBeenCalled();
  });

  it("does not enqueue a wake for a ready route, absent release, or exhausted quota", async () => {
    for (const [options, status] of [
      [{ ready: true }, "route_unavailable"],
      [{ noArtifact: true }, "unavailable"],
      [{ rateLimited: true }, "rate_limited"],
    ] as const) {
      const fixture = await setup(options);
      expect(await requestAuthorizedServiceWake(fixture.context, fixture.input)).toEqual({ status });
      expect(fixture.requestDesiredState).not.toHaveBeenCalled();
    }
  });
});
