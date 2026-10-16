import { AccessGrantId, generateUlid, ok, type Result } from "../domain.js";
import { issueAccessGrant } from "../access-grant.js";
import type { FreshRepositoryAccessChecker, RepositoryPermission } from "../repository-access.js";
import type { SigningKey } from "../jwt.js";
import type { SessionStore } from "../session/types.js";
import { consumeHandoffCode, type HandoffConsumeError } from "./lifecycle.js";
import type { HandoffCodeRecord, HandoffCodeStore } from "./types.js";

export interface CompleteHandoffDependencies {
  readonly handoffStore: HandoffCodeStore;
  readonly sessionStore: SessionStore;
  readonly repositoryAccessChecker: FreshRepositoryAccessChecker;
  readonly codePepper: Uint8Array;
  readonly signingKey: SigningKey;
  readonly issuer: string;
  readonly tokenTtlSeconds: number;
}

export interface CompleteHandoffInput {
  readonly rawCode: string;
  readonly presentedHostname: string;
  readonly presentedRepositoryId: number;
  readonly presentedInstanceId: string;
  readonly presentedRuntimeEpoch: number;
  readonly presentedOrigin: string;
  readonly presentedReturnPath: string;
  readonly presentedAudience: "instance-access";
  readonly now: string;
}

export interface CompletedHandoff {
  readonly token: string;
  readonly expiresAt: string;
  readonly userId: HandoffCodeRecord["userId"];
  readonly gatewaySessionDigest: string;
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
  readonly origin: string;
  readonly permissions: readonly RepositoryPermission[];
  readonly sessionExpiresAt: string;
}

/** Consumes a one-use handoff only after binding it to the exact repo, origin, instance, and epoch. */
export async function completeInstanceHandoff(
  deps: CompleteHandoffDependencies,
  input: CompleteHandoffInput,
): Promise<Result<CompletedHandoff, HandoffConsumeError>> {
  const consumed = await consumeHandoffCode(deps.handoffStore, {
    rawCode: input.rawCode,
    pepper: deps.codePepper,
    presentedHostname: input.presentedHostname,
    now: input.now,
    presentedRepositoryId: input.presentedRepositoryId,
    presentedInstanceId: input.presentedInstanceId,
    presentedRuntimeEpoch: input.presentedRuntimeEpoch,
    presentedOrigin: input.presentedOrigin,
    presentedReturnPath: input.presentedReturnPath,
    presentedAudience: input.presentedAudience,
  });
  if (!consumed.ok) return consumed;

  let session: Awaited<ReturnType<SessionStore["get"]>>;
  try {
    session = await deps.sessionStore.get(consumed.value.gatewaySessionDigest);
  } catch {
    return {
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE", message: "session store unavailable" },
    };
  }
  if (
    !session ||
    session.userId !== consumed.value.userId ||
    (session.revokedAt !== null &&
      new Date(session.revokedAt).getTime() <= new Date(input.now).getTime()) ||
    new Date(session.expiresAt).getTime() <= new Date(input.now).getTime()
  ) {
    return {
      ok: false,
      error: { code: "SESSION_INVALID", message: "handoff session is no longer active" },
    };
  }

  let access;
  try {
    access = await deps.repositoryAccessChecker.checkBoundAccess(
      consumed.value.userId,
      consumed.value.repositoryId,
      consumed.value.instanceId,
      consumed.value.runtimeEpoch,
      input.now,
    );
  } catch {
    return {
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE", message: "repository authority unavailable" },
    };
  }
  if (access.status === "unavailable") {
    return {
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE", message: "repository authority unavailable" },
    };
  }
  if (
    access.status !== "allowed" ||
    access.repositoryId !== consumed.value.repositoryId ||
    access.instanceId !== consumed.value.instanceId ||
    access.runtimeEpoch !== consumed.value.runtimeEpoch ||
    access.origin !== consumed.value.origin ||
    access.origin !== input.presentedOrigin
  ) {
    return {
      ok: false,
      error: { code: "INSTANCE_ACCESS_DENIED", message: "repository access is no longer allowed" },
    };
  }

  const permissions = consumed.value.requestedPermissions.filter((permission) =>
    access.permissions.includes(permission),
  );
  if (permissions.length === 0 || !permissions.includes("read")) {
    return {
      ok: false,
      error: { code: "INSTANCE_ACCESS_DENIED", message: "repository access is no longer allowed" },
    };
  }
  const nowMs = new Date(input.now).getTime();
  const sessionSecondsRemaining = Math.floor(
    (new Date(session.expiresAt).getTime() - nowMs) / 1000,
  );
  const accessSecondsRemaining = Math.floor((access.expiresAt - nowMs) / 1000);
  const grantTtlSeconds = Math.min(
    deps.tokenTtlSeconds,
    300,
    sessionSecondsRemaining,
    accessSecondsRemaining,
  );
  if (grantTtlSeconds < 1) {
    return {
      ok: false,
      error: { code: "SESSION_INVALID", message: "handoff authority has expired" },
    };
  }

  const issued = await issueAccessGrant(deps.signingKey, {
    id: AccessGrantId.parse(`agr_${generateUlid()}`),
    issuer: deps.issuer,
    audience: access.origin,
    subjectUserId: consumed.value.userId,
    repositoryId: consumed.value.repositoryId,
    audienceInstanceId: consumed.value.instanceId,
    runtimeEpoch: consumed.value.runtimeEpoch,
    permissions,
    sessionRevision: session.sessionRevision,
    authorizationRevision: access.authorizationRevision,
    now: input.now,
    ttlSeconds: grantTtlSeconds,
  });

  return ok({
    token: issued.token,
    expiresAt: new Date(issued.descriptor.exp * 1000).toISOString(),
    userId: consumed.value.userId,
    gatewaySessionDigest: consumed.value.gatewaySessionDigest,
    repositoryId: consumed.value.repositoryId,
    instanceId: consumed.value.instanceId,
    runtimeEpoch: consumed.value.runtimeEpoch,
    origin: access.origin,
    permissions,
    sessionExpiresAt: session.expiresAt,
  });
}
