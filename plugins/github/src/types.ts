import type { AccessDecision } from "@praetorium/contracts";
import type { Result } from "@praetorium/domain";
import type { FreshRepositoryAccessChecker } from "@praetorium/auth";

export type GitHubRepositoryId = number;
export type GitHubInstallationId = number;
export type RepositoryAction = "read" | "write" | "maintain" | "admin";
export type RepositoryRole = "read" | "write" | "maintain" | "admin";
export type GitCredentialOperation = "fetch" | "publish";

export interface GitHubOAuthTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly accessTokenExpiresAt: string | null;
  readonly refreshTokenExpiresAt: string | null;
}

export interface GitHubUserTokenSource {
  /** Returns a current token from encrypted Platform storage, refreshing it when necessary. */
  accessTokenFor(userId: string, now: string): Promise<string | null>;
}

export interface GitHubRepositoryPermissions {
  readonly admin?: boolean;
  readonly maintain?: boolean;
  readonly push?: boolean;
  readonly triage?: boolean;
  readonly pull?: boolean;
}

export interface GitHubRepository {
  readonly id: GitHubRepositoryId;
  readonly name: string;
  readonly fullName: string;
  readonly owner: string;
  readonly private: boolean;
  readonly permissions: GitHubRepositoryPermissions;
}

export interface GitHubInstallation {
  readonly id: GitHubInstallationId;
  readonly appId: number;
  readonly suspendedAt: string | null;
  readonly repositorySelection: "all" | "selected";
  readonly permissions: Readonly<Record<string, string>>;
}

export interface RepositoryBinding {
  readonly repositoryId: GitHubRepositoryId;
  readonly installationId: GitHubInstallationId;
  readonly owner: string;
  readonly name: string;
  readonly instanceId: string;
  readonly physicalInstanceId?: string;
  readonly runtimeEpoch: number;
  readonly authorizationRevision: number;
  readonly bindingEpoch: number;
  readonly status: "active" | "suspended" | "blocked" | "retiring";
}

export interface RepositoryBindingReader {
  getByRepositoryId(
    repositoryId: GitHubRepositoryId,
    currentRuntime?: CurrentRuntimeBinding | null,
  ): Promise<RepositoryBinding | null>;
}

export interface GitHubServicePolicy {
  allowsRepository(repository: GitHubRepository): Promise<boolean>;
}

export interface GitHubAccessApi {
  listUserInstallations(accessToken: string): Promise<readonly GitHubInstallation[]>;
  listInstallationRepositories(
    accessToken: string,
    installationId: GitHubInstallationId,
  ): Promise<readonly GitHubRepository[]>;
}

export interface AccessibleRepository {
  readonly repositoryId: GitHubRepositoryId;
  readonly installationId: GitHubInstallationId;
  readonly owner: string;
  readonly name: string;
  readonly private: boolean;
  readonly role: RepositoryRole;
}

export interface GitHubAccessProvider extends FreshRepositoryAccessChecker {
  listRepositories(userId: string): Promise<Result<readonly AccessibleRepository[], AccessError>>;
  authorize(user: string, repositoryId: number, action: RepositoryAction): Promise<AccessDecision>;
}

/** Trusted, stable-origin derivation for the current logical instance. */
export type InstanceOriginResolver = (instanceId: string, repositoryId: number) => string;

export type AccessErrorCode = "USER_AUTHORIZATION_MISSING" | "UPSTREAM_UNAVAILABLE";

export interface AccessError {
  readonly code: AccessErrorCode;
  readonly message: string;
}

export interface RuntimeIdentityProof {
  readonly serviceToken: string;
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly physicalInstanceId?: string;
  readonly repositoryId: number;
  readonly installationId: number;
  readonly runtimeEpoch: number;
  readonly leaseId: string;
}

export interface RuntimeIdentity {
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly physicalInstanceId?: string;
  readonly repositoryId: number;
  readonly installationId: number;
  readonly runtimeEpoch: number;
  readonly leaseId: string;
}

export interface RuntimeIdentityAuthenticator {
  authenticate(proof: RuntimeIdentityProof): Promise<RuntimeIdentity | null>;
}

export interface CurrentRuntimeBinding {
  readonly bindingId?: string;
  readonly repositoryId: number;
  readonly installationId: number;
  readonly instanceId: string;
  readonly physicalInstanceId?: string;
  readonly runtimeEpoch: number;
  readonly leaseId: string;
  readonly active: boolean;
}

export interface RuntimeBindingReader {
  getCurrent(repositoryId: number): Promise<CurrentRuntimeBinding | null>;
}

export interface ScopedGitCredential {
  readonly username: "x-access-token";
  readonly token: string;
  readonly repositoryId: number;
  readonly permission: "read" | "write";
  readonly runtimeEpoch: number;
  readonly expiresAt: string;
}

export interface GitCredentialBroker {
  issue(
    input:
      | {
          readonly proof: RuntimeIdentityProof;
          readonly operation: "fetch";
          readonly now?: string;
        }
      | {
          readonly proof: RuntimeIdentityProof;
          readonly operation: "publish";
          readonly mutationReceipt: string;
          readonly operationId: string;
          readonly payloadDigest: string;
          readonly now?: string;
        },
  ): Promise<
    | { readonly status: "issued"; readonly credential: ScopedGitCredential }
    | { readonly status: "denied" | "unavailable"; readonly reason: string }
  >;
}
