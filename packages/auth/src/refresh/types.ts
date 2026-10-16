import type { UserId } from "../domain.js";
import type { RepositoryPermission } from "../repository-access.js";

/** Gateway-owned authority behind the host-only Instance Access refresh cookie. */
export interface AccessRefreshCredentialRecord {
  readonly userId: UserId;
  readonly gatewaySessionDigest: string;
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
  readonly origin: string;
  readonly permissions: readonly RepositoryPermission[];
  readonly createdAt: string;
  /** Never exceeds the originating Gateway session expiry. */
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

/** One strongly consistent record per opaque refresh-credential chain. */
export interface AccessRefreshCredentialStore {
  create(
    credentialId: string,
    digest: string,
    record: AccessRefreshCredentialRecord,
  ): Promise<void>;
  get(
    credentialId: string,
  ): Promise<{ readonly digest: string; readonly record: AccessRefreshCredentialRecord } | null>;
  /** Compare-and-rotate is atomic in the record's Durable Object. */
  rotate(
    credentialId: string,
    currentDigest: string,
    nextDigest: string,
    now: string,
  ): Promise<boolean>;
  revoke(credentialId: string, digest: string, revokedAt: string): Promise<boolean>;
}
