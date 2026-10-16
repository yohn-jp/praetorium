import {
  err,
  ok,
  type McpCredentialId,
  type Result,
  type UserId,
} from "../domain.js";
import { keyedDigest } from "../digest.js";
import { generateToken } from "../random.js";
import { roundToBucket } from "../time-bucket.js";
import type { McpCredentialListEntry, McpCredentialRecord, McpCredentialStore } from "./types.js";
import type { RepositoryPermission } from "../repository-access.js";

const CREDENTIAL_ENTROPY_BITS = 256;

/** Recognizable, non-secret prefix so a leaked credential is identifiable in a scan without revealing anything about its value. */
export const MCP_CREDENTIAL_PREFIX = "arcadia_mcp_v1";

/** Structural check only (prefix + minimum length) — never a substitute for digest verification. */
export function isWellFormedMcpCredential(plaintext: string): boolean {
  const withSeparator = `${MCP_CREDENTIAL_PREFIX}_`;
  return (
    plaintext.startsWith(withSeparator) &&
    plaintext.length >= withSeparator.length + Math.ceil(CREDENTIAL_ENTROPY_BITS / 8)
  );
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

export interface CreateMcpCredentialInput {
  readonly id: McpCredentialId;
  readonly userId: UserId;
  readonly sessionRevision: number;
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
  readonly name: string;
  readonly permissions: readonly RepositoryPermission[];
  readonly now: string;
  readonly ttlSeconds: number;
  readonly pepper: Uint8Array;
}

export interface CreatedMcpCredential {
  /** Shown to the caller exactly once; never persisted or logged. */
  readonly plaintext: string;
  readonly digest: string;
  readonly record: McpCredentialRecord;
}

export async function createMcpCredential(
  store: McpCredentialStore,
  input: CreateMcpCredentialInput,
): Promise<CreatedMcpCredential> {
  if (!Number.isSafeInteger(input.sessionRevision) || input.sessionRevision < 0 ||
    !Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1 ||
    !Number.isSafeInteger(input.runtimeEpoch) || input.runtimeEpoch < 0 ||
    !input.permissions.includes("read") || input.ttlSeconds < 1) {
    throw new TypeError("MCP credential binding, permissions, or lifetime is invalid");
  }
  const plaintext = `${MCP_CREDENTIAL_PREFIX}_${generateToken(CREDENTIAL_ENTROPY_BITS)}`;
  const digest = await keyedDigest(input.pepper, plaintext);
  const record: McpCredentialRecord = {
    id: input.id,
    userId: input.userId,
    sessionRevision: input.sessionRevision,
    repositoryId: input.repositoryId,
    instanceId: input.instanceId,
    runtimeEpoch: input.runtimeEpoch,
    name: input.name,
    permissions: [...new Set(input.permissions)],
    createdAt: input.now,
    expiresAt: addSeconds(input.now, input.ttlSeconds),
    lastUsedAt: null,
    revokedAt: null,
  };
  await store.create(digest, record);
  return { plaintext, digest, record };
}

export async function listMcpCredentialsForUser(
  store: McpCredentialStore,
  userId: UserId,
): Promise<readonly McpCredentialListEntry[]> {
  return store.listForUser(userId);
}

export async function revokeMcpCredential(
  store: McpCredentialStore,
  digest: string,
  now: string,
): Promise<void> {
  await store.revoke(digest, now);
}

export async function revokeAllMcpCredentialsForUser(
  store: McpCredentialStore,
  userId: UserId,
  now: string,
): Promise<void> {
  await store.revokeAllForUser(userId, now);
}

export type McpCredentialErrorCode = "NOT_FOUND" | "REVOKED" | "EXPIRED" | "STORAGE_UNAVAILABLE";

export interface McpCredentialError {
  readonly code: McpCredentialErrorCode;
  readonly message: string;
}

export interface VerifiedMcpCredential {
  readonly digest: string;
  readonly record: McpCredentialRecord;
}

/**
 * Verifies a presented plaintext credential. A malformed credential and an
 * unknown-but-well-formed one both resolve to `NOT_FOUND`, so probing
 * credential shapes cannot be distinguished from probing real digests.
 */
export async function verifyMcpCredential(
  store: McpCredentialStore,
  pepper: Uint8Array,
  plaintext: string,
  now: string,
): Promise<Result<VerifiedMcpCredential, McpCredentialError>> {
  if (!isWellFormedMcpCredential(plaintext)) {
    return err({ code: "NOT_FOUND", message: "credential not found" });
  }

  const digest = await keyedDigest(pepper, plaintext);

  let record: McpCredentialRecord | null;
  try {
    record = await store.get(digest);
  } catch {
    return err({ code: "STORAGE_UNAVAILABLE", message: "credential store unavailable" });
  }

  if (!record) {
    return err({ code: "NOT_FOUND", message: "credential not found" });
  }
  if (record.revokedAt && new Date(record.revokedAt).getTime() <= new Date(now).getTime()) {
    return err({ code: "REVOKED", message: "credential has been revoked" });
  }
  if (new Date(record.expiresAt).getTime() <= new Date(now).getTime()) {
    return err({ code: "EXPIRED", message: "credential has expired" });
  }

  return ok({ digest, record });
}

/** Debounced last-used update: writes at most once per bucket window. */
export async function touchMcpCredentialLastUsed(
  store: McpCredentialStore,
  digest: string,
  previousLastUsedAt: string | null,
  now: string,
  bucketSeconds: number,
): Promise<void> {
  if (previousLastUsedAt && roundToBucket(previousLastUsedAt, bucketSeconds) === roundToBucket(now, bucketSeconds)) {
    return;
  }
  await store.touchLastUsed(digest, now);
}
