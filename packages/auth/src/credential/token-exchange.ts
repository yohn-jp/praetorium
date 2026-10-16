import { AccessGrantId, err, generateUlid, ok, type Result } from "../domain.js";
import { issueAccessGrant } from "../access-grant.js";
import type { FreshRepositoryAccessChecker, RepositoryPermission } from "../repository-access.js";
import type { RateLimiter } from "../rate-limit.js";
import type { SigningKey } from "../jwt.js";
import { touchMcpCredentialLastUsed, verifyMcpCredential } from "./lifecycle.js";
import type { McpCredentialStore } from "./types.js";

export type TokenExchangeErrorCode =
  | "INVALID_CREDENTIAL"
  | "INSTANCE_BLOCKED"
  | "AUTHORITY_UNAVAILABLE"
  | "PERMISSION_NOT_GRANTED"
  | "RATE_LIMITED";

export interface TokenExchangeError {
  readonly code: TokenExchangeErrorCode;
  readonly message: string;
}

export interface TokenExchangeDependencies {
  readonly credentialStore: McpCredentialStore;
  readonly credentialPepper: Uint8Array;
  readonly repositoryAccessChecker: FreshRepositoryAccessChecker;
  readonly rateLimiter: RateLimiter;
  readonly signingKey: SigningKey;
  readonly issuer: string;
  readonly tokenTtlSeconds: number;
  readonly lastUsedBucketSeconds: number;
}

export interface TokenExchangeInput {
  readonly credentialPlaintext: string;
  readonly requestedRepositoryId: number;
  readonly requestedInstanceId: string;
  readonly requestedRuntimeEpoch: number;
  readonly audience: string;
  readonly requestedPermissions: readonly RepositoryPermission[];
  readonly now: string;
  readonly rateLimitKey: string;
}

export interface TokenExchangeResult {
  readonly token: string;
  readonly expiresAt: string;
}

/** Exchanges a revocable MCP credential for a short-lived current repository grant. */
export async function exchangeMcpCredentialForAccessToken(
  deps: TokenExchangeDependencies,
  input: TokenExchangeInput,
): Promise<Result<TokenExchangeResult, TokenExchangeError>> {
  const rateLimitAllowed = await deps.rateLimiter.consume(input.rateLimitKey, input.now);
  if (!rateLimitAllowed) {
    return err({ code: "RATE_LIMITED", message: "too many token exchange attempts" });
  }

  const verified = await verifyMcpCredential(
    deps.credentialStore,
    deps.credentialPepper,
    input.credentialPlaintext,
    input.now,
  );
  if (!verified.ok) return err({ code: "INVALID_CREDENTIAL", message: "credential is invalid" });

  const record = verified.value.record;
  if (
    record.repositoryId !== input.requestedRepositoryId ||
    record.instanceId !== input.requestedInstanceId ||
    record.runtimeEpoch !== input.requestedRuntimeEpoch
  ) return err({ code: "INVALID_CREDENTIAL", message: "credential is invalid" });

  let access;
  try {
    access = await deps.repositoryAccessChecker.checkBoundAccess(
      record.userId,
      input.requestedRepositoryId,
      input.requestedInstanceId,
      input.requestedRuntimeEpoch,
      input.now,
    );
  } catch {
    return err({ code: "AUTHORITY_UNAVAILABLE", message: "repository authority is unavailable" });
  }
  if (access.status === "unavailable") {
    return err({ code: "AUTHORITY_UNAVAILABLE", message: "repository authority is unavailable" });
  }
  if (
    access.status !== "allowed" || access.repositoryId !== input.requestedRepositoryId ||
    access.instanceId !== input.requestedInstanceId || access.runtimeEpoch !== input.requestedRuntimeEpoch
  ) return err({ code: "INSTANCE_BLOCKED", message: "repository is not currently accessible" });

  const requested = new Set(input.requestedPermissions);
  const grantedPermissions = record.permissions.filter(
    (permission) => requested.has(permission) && access.permissions.includes(permission),
  );
  if (!grantedPermissions.includes("read")) {
    return err({ code: "PERMISSION_NOT_GRANTED", message: "requested repository permissions are not granted" });
  }

  await touchMcpCredentialLastUsed(
    deps.credentialStore,
    verified.value.digest,
    record.lastUsedAt,
    input.now,
    deps.lastUsedBucketSeconds,
  );

  const secondsToDecisionExpiry = Math.floor((access.expiresAt - new Date(input.now).getTime()) / 1000);
  const grantTtlSeconds = Math.min(deps.tokenTtlSeconds, 300, secondsToDecisionExpiry);
  if (grantTtlSeconds < 1) {
    return err({ code: "INSTANCE_BLOCKED", message: "repository authorization expired" });
  }
  const issued = await issueAccessGrant(deps.signingKey, {
    id: AccessGrantId.parse(`agr_${generateUlid()}`),
    issuer: deps.issuer,
    audience: input.audience,
    subjectUserId: record.userId,
    repositoryId: input.requestedRepositoryId,
    audienceInstanceId: input.requestedInstanceId,
    runtimeEpoch: input.requestedRuntimeEpoch,
    permissions: grantedPermissions,
    sessionRevision: record.sessionRevision,
    authorizationRevision: access.authorizationRevision,
    now: input.now,
    ttlSeconds: grantTtlSeconds,
  });

  return ok({ token: issued.token, expiresAt: new Date(issued.descriptor.exp * 1000).toISOString() });
}
