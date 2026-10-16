import {
  err,
  ok,
  AccessGrantId,
  type Result,
  generateUlid,
  type UserId,
} from "../domain.js";
import { issueAccessGrant } from "../access-grant.js";
import { keyedDigest } from "../digest.js";
import type { SigningKey } from "../jwt.js";
import { generateToken } from "../random.js";
import type { SessionRecord, SessionStore } from "../session/types.js";
import type { FreshRepositoryAccessChecker, RepositoryPermission } from "../repository-access.js";
import type { AccessRefreshCredentialRecord, AccessRefreshCredentialStore } from "./types.js";

const REFRESH_CREDENTIAL_PREFIX = "arcadia_refresh_v1";
const REFRESH_CREDENTIAL_ID_ENTROPY_BITS = 128;
const REFRESH_CREDENTIAL_SECRET_ENTROPY_BITS = 256;

export type AccessRefreshErrorCode =
  | "INVALID_CREDENTIAL"
  | "SESSION_INVALID"
  | "INSTANCE_BLOCKED"
  | "STORAGE_UNAVAILABLE";

export interface AccessRefreshError {
  readonly code: AccessRefreshErrorCode;
  readonly message: string;
}

export interface CreatedAccessRefreshCredential {
  readonly plaintext: string;
  readonly credentialId: string;
  readonly digest: string;
  readonly record: AccessRefreshCredentialRecord;
}

export interface CreateAccessRefreshCredentialInput {
  readonly userId: UserId;
  readonly gatewaySessionDigest: string;
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
  readonly origin: string;
  readonly permissions: readonly RepositoryPermission[];
  readonly now: string;
  readonly sessionExpiresAt: string;
  readonly pepper: Uint8Array;
}

function isWellFormedCredential(plaintext: string): boolean {
  const idLength = Math.ceil(REFRESH_CREDENTIAL_ID_ENTROPY_BITS / 6);
  const secretLength = Math.ceil(REFRESH_CREDENTIAL_SECRET_ENTROPY_BITS / 6);
  const pattern = new RegExp(
    `^${REFRESH_CREDENTIAL_PREFIX}\\.([A-Za-z0-9_-]{${idLength}})\\.([A-Za-z0-9_-]{${secretLength}})$`,
  );
  return pattern.test(plaintext);
}

function credentialIdOf(plaintext: string): string | null {
  if (!isWellFormedCredential(plaintext)) return null;
  const [id] = plaintext.slice(`${REFRESH_CREDENTIAL_PREFIX}.`.length).split(".");
  return id ?? null;
}

function newCredential(credentialId?: string): {
  readonly plaintext: string;
  readonly credentialId: string;
} {
  const id = credentialId ?? generateToken(REFRESH_CREDENTIAL_ID_ENTROPY_BITS);
  return {
    plaintext: `${REFRESH_CREDENTIAL_PREFIX}.${id}.${generateToken(REFRESH_CREDENTIAL_SECRET_ENTROPY_BITS)}`,
    credentialId: id,
  };
}

function isActiveSession(
  session: SessionRecord | null,
  userId: UserId,
  now: string,
): session is SessionRecord {
  const nowMs = new Date(now).getTime();
  return Boolean(
    session &&
      session.userId === userId &&
      (!session.revokedAt || new Date(session.revokedAt).getTime() > nowMs) &&
      new Date(session.expiresAt).getTime() > nowMs,
  );
}

export async function createAccessRefreshCredential(
  store: AccessRefreshCredentialStore,
  input: CreateAccessRefreshCredentialInput,
): Promise<CreatedAccessRefreshCredential> {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1 ||
    !Number.isSafeInteger(input.runtimeEpoch) || input.runtimeEpoch < 0 ||
    !input.permissions.includes("read") ||
    new Date(input.sessionExpiresAt).getTime() <= new Date(input.now).getTime()) {
    throw new TypeError("refresh credential cannot outlive an inactive session");
  }
  const { plaintext, credentialId } = newCredential();
  const digest = await keyedDigest(input.pepper, plaintext);
  const record: AccessRefreshCredentialRecord = {
    userId: input.userId,
    gatewaySessionDigest: input.gatewaySessionDigest,
    repositoryId: input.repositoryId,
    instanceId: input.instanceId,
    runtimeEpoch: input.runtimeEpoch,
    origin: input.origin,
    permissions: [...new Set(input.permissions)],
    createdAt: input.now,
    expiresAt: input.sessionExpiresAt,
    revokedAt: null,
  };
  await store.create(credentialId, digest, record);
  return { plaintext, credentialId, digest, record };
}

export interface RefreshAccessGrantDependencies {
  readonly credentialStore: AccessRefreshCredentialStore;
  readonly credentialPepper: Uint8Array;
  readonly sessionStore: SessionStore;
  readonly repositoryAccessChecker: FreshRepositoryAccessChecker;
  readonly signingKey: SigningKey;
  readonly issuer: string;
  readonly tokenTtlSeconds: number;
}

export interface RefreshAccessGrantInput {
  readonly plaintext: string;
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
  readonly origin: string;
  readonly now: string;
}

export interface RefreshedAccessGrant {
  readonly token: string;
  readonly expiresAt: string;
  readonly refreshCredential: string;
  readonly refreshExpiresAt: string;
}

/** Validates the original session and current repository authority, then atomically rotates the refresh secret. */
export async function refreshAccessGrant(
  deps: RefreshAccessGrantDependencies,
  input: RefreshAccessGrantInput,
): Promise<Result<RefreshedAccessGrant, AccessRefreshError>> {
  const credentialId = credentialIdOf(input.plaintext);
  if (!credentialId)
    return err({ code: "INVALID_CREDENTIAL", message: "refresh credential is invalid" });
  const currentDigest = await keyedDigest(deps.credentialPepper, input.plaintext);

  let stored: Awaited<ReturnType<AccessRefreshCredentialStore["get"]>>;
  try {
    stored = await deps.credentialStore.get(credentialId);
  } catch {
    return err({ code: "STORAGE_UNAVAILABLE", message: "refresh credential store unavailable" });
  }
  if (
    !stored ||
    stored.digest !== currentDigest ||
    stored.record.revokedAt !== null ||
    new Date(stored.record.expiresAt).getTime() <= new Date(input.now).getTime() ||
    stored.record.repositoryId !== input.repositoryId ||
    stored.record.instanceId !== input.instanceId ||
    stored.record.runtimeEpoch !== input.runtimeEpoch ||
    stored.record.origin !== input.origin
  ) {
    return err({ code: "INVALID_CREDENTIAL", message: "refresh credential is invalid" });
  }

  let session: Awaited<ReturnType<SessionStore["get"]>>;
  try {
    session = await deps.sessionStore.get(stored.record.gatewaySessionDigest);
  } catch {
    return err({ code: "STORAGE_UNAVAILABLE", message: "session store unavailable" });
  }
  if (!isActiveSession(session, stored.record.userId, input.now)) {
    return err({ code: "SESSION_INVALID", message: "Gateway session is no longer active" });
  }

  let access: Awaited<ReturnType<FreshRepositoryAccessChecker["checkBoundAccess"]>>;
  try {
    access = await deps.repositoryAccessChecker.checkBoundAccess(
      stored.record.userId,
      input.repositoryId,
      input.instanceId,
      input.runtimeEpoch,
      input.now,
    );
  } catch {
    return err({ code: "STORAGE_UNAVAILABLE", message: "instance authority unavailable" });
  }
  if (access.status !== "allowed" || access.repositoryId !== input.repositoryId ||
    access.instanceId !== input.instanceId || access.runtimeEpoch !== input.runtimeEpoch) {
    return err({ code: "INSTANCE_BLOCKED", message: "repository is not currently accessible" });
  }
  const permissions = stored.record.permissions.filter((permission) => access.permissions.includes(permission));
  if (permissions.length === 0 || !permissions.includes("read")) {
    return err({ code: "INSTANCE_BLOCKED", message: "repository is not currently accessible" });
  }

  const secondsRemaining = Math.floor(
    (new Date(session.expiresAt).getTime() - new Date(input.now).getTime()) / 1000,
  );
  const accessSecondsRemaining = Math.floor((access.expiresAt - new Date(input.now).getTime()) / 1000);
  const grantTtlSeconds = Math.min(deps.tokenTtlSeconds, 300, secondsRemaining, accessSecondsRemaining);
  if (grantTtlSeconds < 1) {
    return err({ code: "SESSION_INVALID", message: "Gateway session is no longer active" });
  }

  const { plaintext: nextCredential } = newCredential(credentialId);
  const nextDigest = await keyedDigest(deps.credentialPepper, nextCredential);
  const issued = await issueAccessGrant(deps.signingKey, {
    id: AccessGrantId.parse(`agr_${generateUlid()}`),
    issuer: deps.issuer,
    audience: input.origin,
    subjectUserId: stored.record.userId,
    repositoryId: input.repositoryId,
    audienceInstanceId: input.instanceId,
    runtimeEpoch: input.runtimeEpoch,
    permissions,
    sessionRevision: session.sessionRevision,
    authorizationRevision: access.authorizationRevision,
    now: input.now,
    ttlSeconds: grantTtlSeconds,
  });

  let rotated: boolean;
  try {
    rotated = await deps.credentialStore.rotate(credentialId, currentDigest, nextDigest, input.now);
  } catch {
    return err({ code: "STORAGE_UNAVAILABLE", message: "refresh credential store unavailable" });
  }
  if (!rotated) {
    return err({ code: "INVALID_CREDENTIAL", message: "refresh credential is invalid" });
  }

  return ok({
    token: issued.token,
    expiresAt: new Date(issued.descriptor.exp * 1000).toISOString(),
    refreshCredential: nextCredential,
    refreshExpiresAt: stored.record.expiresAt,
  });
}

export interface RevokeAccessRefreshCredentialInput {
  readonly plaintext: string;
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
  readonly origin: string;
  readonly now: string;
}

/** Revocation is scoped to the exact refresh chain and host/placement binding. */
export async function revokeAccessRefreshCredential(
  store: AccessRefreshCredentialStore,
  pepper: Uint8Array,
  input: RevokeAccessRefreshCredentialInput,
): Promise<Result<boolean, AccessRefreshError>> {
  const credentialId = credentialIdOf(input.plaintext);
  if (!credentialId) return ok(false);
  const digest = await keyedDigest(pepper, input.plaintext);
  let stored: Awaited<ReturnType<AccessRefreshCredentialStore["get"]>>;
  try {
    stored = await store.get(credentialId);
  } catch {
    return err({ code: "STORAGE_UNAVAILABLE", message: "refresh credential store unavailable" });
  }
  if (
    !stored ||
    stored.digest !== digest ||
    stored.record.repositoryId !== input.repositoryId ||
    stored.record.instanceId !== input.instanceId ||
    stored.record.runtimeEpoch !== input.runtimeEpoch ||
    stored.record.origin !== input.origin
  ) {
    return ok(false);
  }
  try {
    return ok(await store.revoke(credentialId, digest, input.now));
  } catch {
    return err({ code: "STORAGE_UNAVAILABLE", message: "refresh credential store unavailable" });
  }
}
