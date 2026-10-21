import type { UserId } from "../domain.js";

/** Extensible: today only GitHub OAuth issues sessions. */
export type AuthenticationContext = "github-oauth";

/**
 * Persisted session state, keyed in storage by the session's digest — never
 * the raw opaque id presented in the cookie. `rotatedFromDigest` records
 * lineage as a prior digest (itself one-way, safe to retain for audit).
 */
export interface SessionRecord {
  readonly userId: UserId;
  /** Monotonic within a session rotation chain; bound into hosted access grants. */
  readonly sessionRevision: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastActivityBucket: string;
  readonly authenticationContext: AuthenticationContext;
  readonly rotatedFromDigest: string | null;
  /** Takes effect once `now >= revokedAt`, allowing an intentional short grace window during rotation. */
  readonly revokedAt: string | null;
}

export interface SessionStore {
  create(digest: string, record: SessionRecord): Promise<void>;
  /** Atomically enforces the per-user active-session limit and inserts the session. */
  createWithinLimit(
    digest: string,
    record: SessionRecord,
    concurrentSessionLimit: number,
    now: string,
  ): Promise<boolean>;
  get(digest: string): Promise<SessionRecord | null>;
  /** Debounced sliding-expiry update: only `lastActivityBucket` and `expiresAt` change. */
  touch(digest: string, lastActivityBucket: string, expiresAt: string): Promise<void>;
  revoke(digest: string, revokedAt: string): Promise<void>;
  /** Logout-all-devices: revokes every currently-unrevoked session for a user. */
  revokeAllForUser(userId: UserId, revokedAt: string): Promise<void>;
  /** Active (unrevoked, unexpired) session count, for the concurrent-session limit. */
  countActiveForUser(userId: UserId, now: string): Promise<number>;
}
