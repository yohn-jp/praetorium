import { applicationHostname, publicRuntimeIdentity, type AppIdentity } from "@praetorium/contracts";
import { importPublicKeyJwk, verifyAccessToken } from "@praetorium/auth";
import type { GatewayContext } from "../context.js";
import { hasReadyCurrentRuntime, runtimeEpochForAccess } from "../active-runtime.js";

export interface AuthorizedServiceWake {
  readonly appIdentity: AppIdentity;
  readonly repositoryId: number;
  readonly origin: string;
  readonly accessGrant: string;
}

export type ServiceWakeResult =
  | { readonly status: "unauthorized" }
  | { readonly status: "unavailable" }
  | { readonly status: "rate_limited" }
  | { readonly status: "not_found" }
  | { readonly status: "route_unavailable" }
  | { readonly status: "starting" };

/**
 * Wake a stopped application from a bearer-authenticated service request.
 * The service identity comes from the validated stable hostname, never a token
 * claim or request-provided redirect. No application body is forwarded.
 */
export async function requestAuthorizedServiceWake(
  context: GatewayContext,
  input: AuthorizedServiceWake,
): Promise<ServiceWakeResult> {
  const expectedOrigin = `https://${applicationHostname(input.appIdentity, input.repositoryId)}`;
  if (input.origin !== expectedOrigin) return { status: "unauthorized" };
  const snapshot = await context.controlPlane.getByRepositoryId(input.repositoryId);
  if (!snapshot || snapshot.binding.suspended ||
      snapshot.binding.repositoryId !== input.repositoryId ||
      snapshot.instance.repositoryId !== input.repositoryId ||
      (snapshot.binding.appIdentity ?? "scriptorium") !== input.appIdentity) {
    return { status: "not_found" };
  }

  const epoch = runtimeEpochForAccess(snapshot.instance);
  const identity = publicRuntimeIdentity(snapshot.instance);
  const registry = await context.getKeyRegistry();
  const verified = await verifyAccessToken({
    token: input.accessGrant,
    expectedIssuer: context.config.origin,
    expectedAudience: expectedOrigin,
    expectedInstanceId: identity,
    expectedRepositoryId: input.repositoryId,
    expectedRuntimeEpoch: epoch,
    requiredPermissions: ["read"],
    now: context.requestNow,
    clockSkewSeconds: 0,
    resolveKey: async (kid) => {
      const key = registry.find((candidate) => candidate.kid === kid && candidate.status !== "compromised");
      return key ? importPublicKeyJwk(key.publicKeyJwk) : null;
    },
  });
  if (!verified.ok) return { status: "unauthorized" };

  const access = await context.githubAccess.checkBoundAccess(
    verified.value.sub, input.repositoryId, snapshot.instance.instanceId, epoch, context.requestNow,
  );
  if (access.status === "unavailable") return { status: "unavailable" };
  if (access.status !== "allowed" ||
      access.repositoryId !== input.repositoryId ||
      access.instanceId !== snapshot.instance.instanceId ||
      access.runtimeEpoch !== epoch ||
      access.installationId !== snapshot.binding.installationId ||
      access.authorizationRevision !== snapshot.binding.authorizationRevision ||
      verified.value.authorizationRevision !== access.authorizationRevision ||
      access.expiresAt <= Date.parse(context.requestNow) ||
      !access.permissions.includes("read")) return { status: "unauthorized" };

  // A ready runtime seen through the fallback is a routing fault, not a wake.
  if (hasReadyCurrentRuntime(snapshot.instance)) return { status: "route_unavailable" };
  if (!snapshot.instance.desiredArtifactDigest ||
      snapshot.instance.observedState === "failed") return { status: "unavailable" };
  // A wake already queued/running should not enqueue a new operation for each
  // retried MCP request. Only the stopped-to-running transition needs a CAS.
  if (snapshot.instance.desiredState === "running") return { status: "starting" };

  if (snapshot.instance.desiredState === "stopped" &&
      !(await context.wakeRateLimiter.consume(`${verified.value.sub}:${input.repositoryId}`, context.requestNow))) {
    return { status: "rate_limited" };
  }

  // Use the same Control Plane desired-state CAS as browser entry. This does not
  // submit, cache or replay the original MCP/API request.
  await context.controlPlane.requestDesiredState(snapshot.instance.instanceId, {
    actorId: verified.value.sub,
    expectedGeneration: snapshot.instance.generation,
    desiredState: "running",
    ...(snapshot.instance.legacyRuntimeEpoch != null &&
        snapshot.instance.runtimeEpoch === snapshot.instance.legacyRuntimeEpoch
      ? { forceNewRuntime: true } : {}),
    idempotencyKey: `wake_${crypto.randomUUID()}`,
    bindingEpoch: snapshot.binding.bindingEpoch,
    authorizationRevision: access.authorizationRevision,
    requestId: context.requestId,
    now: Date.parse(context.requestNow),
  });
  return { status: "starting" };
}
