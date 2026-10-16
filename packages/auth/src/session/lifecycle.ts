import { err, ok, type Result, type UserId } from "../domain.js";
import { keyedDigest } from "../digest.js";
import { generateToken } from "../random.js";
import { roundToBucket } from "../time-bucket.js";
import type { AuthenticationContext, SessionRecord, SessionStore } from "./types.js";

const SESSION_ID_ENTROPY_BITS = 256;

export type SessionErrorCode =
  | "CONCURRENT_SESSION_LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "EXPIRED"
  | "REVOKED"
  | "STORAGE_UNAVAILABLE";

export interface SessionError {
  readonly code: SessionErrorCode;
  readonly message: string;
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

/** Rounds `now` down to a bucket boundary so activity can be tracked without a write per request. */
export function activityBucket(now: string, bucketSeconds: number): string {
  return roundToBucket(now, bucketSeconds);
}

async function guardedCount(
  store: SessionStore,
  userId: UserId,
  now: string,
): Promise<Result<number, SessionError>> {
  try {
    return ok(await store.countActiveForUser(userId, now));
  } catch {
    return err({ code: "STORAGE_UNAVAILABLE", message: "session store unavailable" });
  }
}

export interface CreatedSession {
  readonly rawSessionId: string;
  readonly digest: string;
  readonly record: SessionRecord;
}

export interface CreateSessionInput {
  readonly userId: UserId;
  readonly sessionRevision?: number;
  readonly authenticationContext: AuthenticationContext;
  readonly now: string;
  readonly ttlSeconds: number;
  readonly pepper: Uint8Array;
  readonly concurrentSessionLimit: number;
  readonly rotatedFromDigest?: string | null;
}

/** Creates a new session, enforcing the per-user concurrent-session limit. Fails closed on storage errors. */
export async function createSession(
  store: SessionStore,
  input: CreateSessionInput,
): Promise<Result<CreatedSession, SessionError>> {
  const activeCount = await guardedCount(store, input.userId, input.now);
  if (!activeCount.ok) {
    return activeCount;
  }
  if (activeCount.value >= input.concurrentSessionLimit) {
    return err({
      code: "CONCURRENT_SESSION_LIMIT_EXCEEDED",
      message: "user has reached the concurrent session limit",
    });
  }

  const rawSessionId = generateToken(SESSION_ID_ENTROPY_BITS);
  const digest = await keyedDigest(input.pepper, rawSessionId);
  const sessionRevision = input.sessionRevision ?? 0;
  if (!Number.isSafeInteger(sessionRevision) || sessionRevision < 0) {
    throw new TypeError("sessionRevision must be a non-negative integer");
  }
  const record: SessionRecord = {
    userId: input.userId,
    sessionRevision,
    createdAt: input.now,
    expiresAt: addSeconds(input.now, input.ttlSeconds),
    lastActivityBucket: input.now,
    authenticationContext: input.authenticationContext,
    rotatedFromDigest: input.rotatedFromDigest ?? null,
    revokedAt: null,
  };

  try {
    await store.create(digest, record);
  } catch {
    return err({ code: "STORAGE_UNAVAILABLE", message: "session store unavailable" });
  }

  return ok({ rawSessionId, digest, record });
}

export interface ResolvedSession {
  readonly digest: string;
  readonly record: SessionRecord;
}

/**
 * Resolves the raw session id presented by a browser to its record. No
 * GitHub API call or filesystem I/O is involved — only a keyed digest and a
 * store lookup. Any storage failure fails closed (`STORAGE_UNAVAILABLE`),
 * never silently treating the caller as authenticated.
 */
export async function resolveSession(
  store: SessionStore,
  pepper: Uint8Array,
  rawSessionId: string,
  now: string,
): Promise<Result<ResolvedSession, SessionError>> {
  const digest = await keyedDigest(pepper, rawSessionId);

  let record: SessionRecord | null;
  try {
    record = await store.get(digest);
  } catch {
    return err({ code: "STORAGE_UNAVAILABLE", message: "session store unavailable" });
  }

  if (!record) {
    return err({ code: "NOT_FOUND", message: "session not found" });
  }
  if (record.revokedAt && new Date(record.revokedAt).getTime() <= new Date(now).getTime()) {
    return err({ code: "REVOKED", message: "session has been revoked" });
  }
  if (new Date(record.expiresAt).getTime() <= new Date(now).getTime()) {
    return err({ code: "EXPIRED", message: "session has expired" });
  }

  return ok({ digest, record });
}

export interface TouchSessionInput {
  readonly digest: string;
  readonly record: SessionRecord;
  readonly now: string;
  readonly bucketSeconds: number;
  readonly slidingTtlSeconds: number;
}

/**
 * Sliding-expiry touch, debounced to one write per activity bucket instead
 * of one write per request.
 */
export async function touchSession(store: SessionStore, input: TouchSessionInput): Promise<void> {
  const bucket = activityBucket(input.now, input.bucketSeconds);
  if (bucket === input.record.lastActivityBucket) {
    return;
  }
  await store.touch(input.digest, bucket, addSeconds(input.now, input.slidingTtlSeconds));
}

/** Immediate revocation (logout, single-session revoke). */
export async function revokeSession(store: SessionStore, digest: string, now: string): Promise<void> {
  await store.revoke(digest, now);
}

/** Logout-all-devices. */
export async function revokeAllSessionsForUser(
  store: SessionStore,
  userId: UserId,
  now: string,
): Promise<void> {
  await store.revokeAllForUser(userId, now);
}

export interface RotateSessionInput {
  readonly digest: string;
  readonly record: SessionRecord;
  readonly now: string;
  readonly ttlSeconds: number;
  readonly pepper: Uint8Array;
  readonly concurrentSessionLimit: number;
  /**
   * Optional bounded overlap during which the pre-rotation id still
   * resolves, to tolerate requests already in flight. Zero (default)
   * revokes the old id immediately — a stolen pre-rotation id is rejected
   * as soon as rotation completes.
   */
  readonly graceSeconds?: number;
}

/**
 * Rotates a session: issues a new id linked by lineage to the old digest,
 * then revokes the old one (immediately, or after `graceSeconds`). The old
 * and new ids are never simultaneously valid beyond that explicit window.
 */
export async function rotateSession(
  store: SessionStore,
  input: RotateSessionInput,
): Promise<Result<CreatedSession, SessionError>> {
  const created = await createSession(store, {
    userId: input.record.userId,
    sessionRevision: input.record.sessionRevision + 1,
    authenticationContext: input.record.authenticationContext,
    now: input.now,
    ttlSeconds: input.ttlSeconds,
    pepper: input.pepper,
    // The pre-rotation session is still active until revoked below, so it
    // must not itself count against the limit for the newly created one.
    concurrentSessionLimit: input.concurrentSessionLimit + 1,
    rotatedFromDigest: input.digest,
  });
  if (!created.ok) {
    return created;
  }

  const grace = input.graceSeconds ?? 0;
  await store.revoke(input.digest, grace > 0 ? addSeconds(input.now, grace) : input.now);

  return created;
}
