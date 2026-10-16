import type { UserId } from "../domain.js";
import type { RepositoryPermission } from "../repository-access.js";

/** A single one-time browser handoff bound to its Gateway session and exact access-service placement. */
export interface HandoffCodeRecord {
  readonly userId: UserId;
  readonly gatewaySessionDigest: string;
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
  readonly hostname: string;
  readonly origin: string;
  readonly audience: "instance-access";
  readonly returnPath: string;
  readonly requestedPermissions: readonly RepositoryPermission[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface HandoffCodeStore {
  save(digest: string, record: HandoffCodeRecord): Promise<void>;
  /** Atomically retrieves and deletes; `null` if never issued, already consumed, or evicted — never re-readable. */
  consume(digest: string): Promise<HandoffCodeRecord | null>;
}
