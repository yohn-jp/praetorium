import type { AccessGrant } from "@praetorium/contracts";

export type RepositoryPermission = AccessGrant["permissions"][number];

/** A current GitHub decision tied to the exact repository binding being entered. */
export type FreshRepositoryAccessResult =
  | {
      readonly status: "allowed";
      readonly repositoryId: number;
      readonly installationId: number;
      readonly instanceId: string;
      readonly runtimeEpoch: number;
      readonly authorizationRevision: number;
      readonly permissions: readonly RepositoryPermission[];
      /** Unix milliseconds, matching the neutral AccessDecision contract. */
      readonly checkedAt: number;
      readonly expiresAt: number;
    }
  | { readonly status: "denied" | "unavailable" };

/**
 * Rechecks user/App intersection and the current repository binding before
 * issuing or refreshing any repository-scoped grant.
 */
export interface FreshRepositoryAccessChecker {
  checkBoundAccess(
    userId: string,
    repositoryId: number,
    instanceId: string,
    runtimeEpoch: number,
    now: string,
  ): Promise<FreshRepositoryAccessResult>;
}
