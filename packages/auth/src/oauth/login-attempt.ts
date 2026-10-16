/** A single in-flight login attempt, keyed by its own `state` value. */
export interface LoginAttemptRecord {
  readonly state: string;
  readonly codeVerifier: string;
  /** SHA-256 digest of the browser-bound nonce cookie; the nonce itself is never persisted. */
  readonly browserNonceDigest: string;
  readonly redirectTo: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface LoginAttemptStore {
  save(record: LoginAttemptRecord): Promise<void>;
  /**
   * Atomically retrieves and deletes the attempt for `state`. Must return
   * `null` for a `state` that was never issued, already consumed, or has
   * been evicted, so a replayed callback can never succeed twice.
   */
  consume(state: string): Promise<LoginAttemptRecord | null>;
}

export function isLoginAttemptExpired(record: LoginAttemptRecord, now: string): boolean {
  return new Date(record.expiresAt).getTime() <= new Date(now).getTime();
}
