import { AccessGrantSchema, type AccessGrant } from "@praetorium/contracts";
import type { AccessGrantId, Result, UserId } from "./domain.js";
import { issueAccessToken, verifyAccessToken, type SigningKey } from "./jwt.js";
import type { AccessTokenClaims, AccessTokenError } from "./jwt.js";

export type AccessGrantPermission = AccessGrant["permissions"][number];
export type AccessGrantDescriptor = AccessGrant;

export interface IssueAccessGrantInput {
  readonly id: AccessGrantId;
  readonly issuer: string;
  readonly audience: string;
  readonly subjectUserId: UserId | string;
  readonly repositoryId: number;
  readonly audienceInstanceId: string;
  readonly runtimeEpoch: number;
  readonly permissions: readonly AccessGrantPermission[];
  readonly sessionRevision: number;
  readonly authorizationRevision: number;
  readonly now: string;
  readonly ttlSeconds: number;
}

export interface IssuedAccessGrant {
  readonly token: string;
  readonly descriptor: AccessGrantDescriptor;
}

/** Issues the strict T01 access-grant shape, bound to one repository and runtime epoch. */
export async function issueAccessGrant(
  signingKey: SigningKey,
  input: IssueAccessGrantInput,
): Promise<IssuedAccessGrant> {
  const token = await issueAccessToken(signingKey, {
    issuer: input.issuer,
    audience: input.audience,
    subjectUserId: input.subjectUserId,
    instanceId: input.audienceInstanceId,
    repositoryId: input.repositoryId,
    runtimeEpoch: input.runtimeEpoch,
    permissions: input.permissions,
    sessionRevision: input.sessionRevision,
    authorizationRevision: input.authorizationRevision,
    now: input.now,
    ttlSeconds: input.ttlSeconds,
    tokenId: input.id,
  });

  const issuedAt = Math.floor(new Date(input.now).getTime() / 1000);
  const descriptor = AccessGrantSchema.parse({
    iss: input.issuer,
    sub: input.subjectUserId,
    aud: input.audience,
    instanceId: input.audienceInstanceId,
    repositoryId: input.repositoryId,
    runtimeEpoch: input.runtimeEpoch,
    permissions: [...new Set(input.permissions)],
    sessionRevision: input.sessionRevision,
    authorizationRevision: input.authorizationRevision,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + input.ttlSeconds,
    jti: input.id,
  });

  return { token, descriptor };
}

export interface VerifyAccessGrantInput {
  readonly token: string;
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly expectedInstanceId: string;
  readonly expectedRepositoryId: number;
  readonly expectedRuntimeEpoch: number;
  readonly requiredPermissions?: readonly AccessGrantPermission[];
  readonly now: string;
  readonly clockSkewSeconds: number;
  readonly resolveKey: (kid: string) => Promise<CryptoKey | null>;
}

export async function verifyAccessGrant(
  input: VerifyAccessGrantInput,
): Promise<Result<AccessTokenClaims, AccessTokenError>> {
  const verified = await verifyAccessToken({
    token: input.token,
    expectedIssuer: input.expectedIssuer,
    expectedAudience: input.expectedAudience,
    expectedInstanceId: input.expectedInstanceId,
    expectedRepositoryId: input.expectedRepositoryId,
    expectedRuntimeEpoch: input.expectedRuntimeEpoch,
    ...(input.requiredPermissions !== undefined
      ? { requiredPermissions: input.requiredPermissions }
      : {}),
    now: input.now,
    clockSkewSeconds: input.clockSkewSeconds,
    resolveKey: input.resolveKey,
  });
  return verified;
}
