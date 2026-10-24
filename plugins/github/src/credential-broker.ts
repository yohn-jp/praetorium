import type {
  FreshRepositoryAccessChecker,
  MutationAuthorizationReceiptVerifier,
} from "@praetorium/auth";
import { GitHubApiError } from "./api.js";
import type {
  RuntimeIdentity,
  GitCredentialBroker,
  RepositoryBindingReader,
  RuntimeBindingReader,
  RuntimeIdentityAuthenticator,
  RuntimeIdentityProof,
} from "./types.js";
import type {
  GitHubInstallationTokenIssuer,
  InstallationToken,
} from "./installation-token.js";

export const GITHUB_PUBLISH_RECEIPT_AUDIENCE = "praetorium-git-publisher";

/** Durable lifecycle tracking required before a runtime bearer token can be returned. */
export interface RuntimeGitCredentialLifecycle {
  /** Reuses a currently active exact-scope credential after current auth checks pass. */
  findReusable?(
    identity: RuntimeIdentity,
    permission: "read" | "write",
    now: string,
  ): Promise<InstallationToken | null>;
  recordIssued(identity: RuntimeIdentity, credential: InstallationToken): Promise<boolean>;
}

export interface GitCredentialBrokerConfig {
  readonly runtimeAuthenticator: RuntimeIdentityAuthenticator;
  readonly runtimeBindings: RuntimeBindingReader;
  readonly repositoryBindings: RepositoryBindingReader;
  readonly accessProvider: FreshRepositoryAccessChecker;
  readonly mutationReceiptVerifier: MutationAuthorizationReceiptVerifier;
  readonly tokenIssuer: GitHubInstallationTokenIssuer;
  readonly credentialLifecycle?: RuntimeGitCredentialLifecycle;
  readonly now?: () => Date;
}

function sameRuntime(
  identity: Awaited<ReturnType<RuntimeIdentityAuthenticator["authenticate"]>>,
  binding: Awaited<ReturnType<RuntimeBindingReader["getCurrent"]>>,
): boolean {
  return Boolean(
    identity &&
      binding &&
      binding.active &&
      identity.repositoryId === binding.repositoryId &&
      identity.installationId === binding.installationId &&
      identity.instanceId === binding.instanceId &&
      identity.runtimeEpoch === binding.runtimeEpoch &&
      identity.leaseId === binding.leaseId,
  );
}

function upstreamFailure(error: unknown): boolean {
  if (!(error instanceof GitHubApiError)) return true;
  return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
}

function validReusableCredential(
  identity: RuntimeIdentity,
  credential: InstallationToken,
  permission: "read" | "write",
  now: Date,
): boolean {
  const expiresAt = new Date(credential.expiresAt);
  return (
    typeof credential.token === "string" &&
    credential.token.length > 0 &&
    credential.repositoryId === identity.repositoryId &&
    credential.installationId === identity.installationId &&
    credential.permission === permission &&
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt.toISOString() === credential.expiresAt &&
    expiresAt.getTime() > now.getTime() + 30_000 &&
    expiresAt.getTime() <= now.getTime() + 3_605_000
  );
}

/** Runtime/repository/epoch scoped credential issuance. There is no static-token fallback. */
export function createGitCredentialBroker(config: GitCredentialBrokerConfig): GitCredentialBroker {
  const now = config.now ?? (() => new Date());

  return {
    async issue(input) {
      if (
        !input ||
        typeof input !== "object" ||
        (input.operation !== "fetch" && input.operation !== "publish")
      ) {
        return { status: "denied", reason: "invalid_operation" };
      }
      const instant = input.now ? new Date(input.now) : now();
      if (!Number.isFinite(instant.getTime()))
        return { status: "denied", reason: "invalid_request_time" };
      let identity;
      try {
        identity = await config.runtimeAuthenticator.authenticate(input.proof);
      } catch {
        return { status: "unavailable", reason: "runtime_identity_unavailable" };
      }
      if (!identity) return { status: "denied", reason: "runtime_identity_invalid" };

      let binding;
      try {
        binding = await config.runtimeBindings.getCurrent(identity.repositoryId);
      } catch {
        return { status: "unavailable", reason: "runtime_binding_unavailable" };
      }
      if (!sameRuntime(identity, binding))
        return { status: "denied", reason: "runtime_binding_stale" };

      let repositoryBinding;
      try {
        repositoryBinding = await config.repositoryBindings.getByRepositoryId(
          identity.repositoryId,
          binding,
        );
      } catch {
        return { status: "unavailable", reason: "repository_binding_unavailable" };
      }
      if (
        !repositoryBinding ||
        repositoryBinding.status !== "active" ||
        repositoryBinding.repositoryId !== identity.repositoryId ||
        repositoryBinding.installationId !== identity.installationId ||
        repositoryBinding.instanceId !== identity.instanceId ||
        repositoryBinding.runtimeEpoch !== identity.runtimeEpoch
      )
        return { status: "denied", reason: "repository_binding_stale" };

      const permission = input.operation === "fetch" ? "read" : "write";
      if (input.operation === "publish") {
        let receiptResult;
        try {
          receiptResult = await config.mutationReceiptVerifier.verify(input.mutationReceipt, {
            repositoryId: identity.repositoryId,
            instanceId: identity.instanceId,
            runtimeEpoch: identity.runtimeEpoch,
            operationId: input.operationId,
            payloadDigest: input.payloadDigest,
            now: instant.toISOString(),
          });
        } catch {
          return { status: "unavailable", reason: "mutation_receipt_verification_unavailable" };
        }
        if (!receiptResult.ok) {
          const unavailable = receiptResult.error.code === "KEY_SOURCE_UNAVAILABLE";
          return {
            status: unavailable ? "unavailable" : "denied",
            reason: unavailable ? "mutation_receipt_keys_unavailable" : "mutation_receipt_invalid",
          };
        }
        const receipt = receiptResult.value;
        if (receipt.authorizationRevision !== repositoryBinding.authorizationRevision) {
          return { status: "denied", reason: "mutation_receipt_authorization_stale" };
        }
        let decision;
        try {
          decision = await config.accessProvider.checkBoundAccess(
            receipt.sub,
            identity.repositoryId,
            identity.instanceId,
            identity.runtimeEpoch,
            instant.toISOString(),
          );
        } catch {
          return { status: "unavailable", reason: "actor_authorization_unavailable" };
        }
        if (
          decision.status !== "allowed" ||
          decision.repositoryId !== identity.repositoryId ||
          decision.instanceId !== identity.instanceId ||
          decision.runtimeEpoch !== identity.runtimeEpoch ||
          decision.installationId !== identity.installationId ||
          decision.authorizationRevision !== receiptResult.value.authorizationRevision ||
          !decision.permissions.includes("write") ||
          decision.expiresAt <= instant.getTime()
        )
          return { status: "denied", reason: "publish_actor_not_authorized" };
      }

      if (config.credentialLifecycle?.findReusable) {
        let reusable: InstallationToken | null;
        try {
          reusable = await config.credentialLifecycle.findReusable(
            identity,
            permission,
            instant.toISOString(),
          );
        } catch {
          return { status: "unavailable", reason: "runtime_credential_registry_unavailable" };
        }
        if (reusable) {
          if (!validReusableCredential(identity, reusable, permission, instant))
            return { status: "unavailable", reason: "runtime_credential_registry_unavailable" };
          return {
            status: "issued",
            credential: {
              username: "x-access-token",
              token: reusable.token,
              repositoryId: identity.repositoryId,
              permission,
              runtimeEpoch: identity.runtimeEpoch,
              expiresAt: reusable.expiresAt,
            },
          };
        }
      }

      try {
        const credential = await config.tokenIssuer.issue(
          identity.installationId,
          identity.repositoryId,
          permission,
          instant.toISOString(),
        );
        if (config.credentialLifecycle) {
          let recorded: boolean;
          try {
            recorded = await config.credentialLifecycle.recordIssued(identity, credential);
          } catch {
            return { status: "unavailable", reason: "runtime_credential_registry_unavailable" };
          }
          if (!recorded) return { status: "denied", reason: "runtime_retired" };
        }
        return {
          status: "issued",
          credential: {
            username: "x-access-token",
            token: credential.token,
            repositoryId: identity.repositoryId,
            permission,
            runtimeEpoch: identity.runtimeEpoch,
            expiresAt: credential.expiresAt,
          },
        };
      } catch (error) {
        return {
          status: upstreamFailure(error) ? "unavailable" : "denied",
          reason: upstreamFailure(error)
            ? "installation_credential_unavailable"
            : "installation_not_active",
        };
      }
    },
  };
}

export type RuntimeCredentialProof = RuntimeIdentityProof;
