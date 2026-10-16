import type { FreshRepositoryAccessChecker } from "@praetorium/auth";
import { GitHubApiError } from "./api.js";
import type {
  GitCredentialBroker,
  RepositoryBindingReader,
  RuntimeBindingReader,
  RuntimeIdentityAuthenticator,
  RuntimeIdentityProof,
} from "./types.js";
import type { GitHubInstallationTokenIssuer } from "./installation-token.js";

export interface GitCredentialBrokerConfig {
  readonly runtimeAuthenticator: RuntimeIdentityAuthenticator;
  readonly runtimeBindings: RuntimeBindingReader;
  readonly repositoryBindings: RepositoryBindingReader;
  readonly accessProvider: FreshRepositoryAccessChecker;
  readonly tokenIssuer: GitHubInstallationTokenIssuer;
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

/** Runtime/repository/epoch scoped credential issuance. There is no static-token fallback. */
export function createGitCredentialBroker(config: GitCredentialBrokerConfig): GitCredentialBroker {
  const now = config.now ?? (() => new Date());

  return {
    async issue(input) {
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
        if (!input.actorUserId) return { status: "denied", reason: "publish_actor_required" };
        let decision;
        try {
          decision = await config.accessProvider.checkBoundAccess(
            input.actorUserId,
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
          !decision.permissions.includes("write") ||
          decision.expiresAt <= instant.getTime()
        )
          return { status: "denied", reason: "publish_actor_not_authorized" };
      }

      try {
        const credential = await config.tokenIssuer.issue(
          identity.installationId,
          identity.repositoryId,
          permission,
          instant.toISOString(),
        );
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
