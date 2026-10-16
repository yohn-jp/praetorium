import type { AccessDecision } from "@praetorium/contracts";
import { err, ok } from "@praetorium/domain";
import { GitHubApiError } from "./api.js";
import type {
  AccessError,
  AccessibleRepository,
  GitHubAccessApi,
  GitHubInstallation,
  GitHubRepository,
  GitHubServicePolicy,
  GitHubUserTokenSource,
  RepositoryAction,
  RepositoryBinding,
  RepositoryBindingReader,
  RepositoryRole,
} from "./types.js";
import type { FreshRepositoryAccessResult } from "@praetorium/auth";

export interface GitHubAccessProviderConfig {
  readonly appId: number;
  readonly api: GitHubAccessApi;
  readonly userTokens: GitHubUserTokenSource;
  readonly repositoryBindings: RepositoryBindingReader;
  readonly servicePolicy: GitHubServicePolicy;
  readonly now?: () => Date;
}

/** Thrown only when GitHub or authority storage cannot provide a fresh decision. */
export class GitHubAccessUnavailableError extends Error {
  constructor() {
    super("GitHub authorization could not be checked");
    this.name = "GitHubAccessUnavailableError";
  }
}

function hasContentsRead(installation: GitHubInstallation): boolean {
  return (
    installation.permissions.contents === "read" || installation.permissions.contents === "write"
  );
}

function permissionsFor(
  repository: GitHubRepository,
  installation: GitHubInstallation,
): readonly RepositoryAction[] {
  if (!hasContentsRead(installation)) return [];
  const user = repository.permissions;
  if (!(user.pull || user.triage || user.push || user.maintain || user.admin)) return [];
  const permissions: RepositoryAction[] = ["read"];
  const appCanWrite = installation.permissions.contents === "write";
  const userCanWrite = Boolean(user.push || user.maintain || user.admin);
  if (appCanWrite && userCanWrite) permissions.push("write");
  if (user.maintain) permissions.push("maintain");
  if (user.admin) permissions.push("admin");
  return permissions;
}

function roleFor(permissions: readonly RepositoryAction[]): RepositoryRole | null {
  if (permissions.includes("admin")) return "admin";
  if (permissions.includes("maintain")) return "maintain";
  if (permissions.includes("write")) return "write";
  if (permissions.includes("read")) return "read";
  return null;
}

function plusSeconds(date: Date, seconds: number): number {
  return date.getTime() + seconds * 1000;
}

function decisionFor(
  repositoryId: number,
  installationId: number,
  permissions: readonly RepositoryAction[],
  checkedAt: number,
  allowed: boolean,
  action: RepositoryAction,
): AccessDecision {
  const lifetimeSeconds = action === "read" ? 300 : 30;
  return {
    allowed: allowed && permissions.includes(action),
    permissions: [...permissions],
    checkedAt,
    expiresAt:
      allowed && permissions.includes(action)
        ? plusSeconds(new Date(checkedAt), lifetimeSeconds)
        : checkedAt,
    installationId,
    repositoryId,
  };
}

function isUnavailable(error: unknown): boolean {
  if (error instanceof GitHubApiError) {
    return (
      error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500
    );
  }
  return true;
}

function mapAccessError(error: unknown): AccessError {
  if (error instanceof GitHubApiError && (error.status === 401 || error.status === 403)) {
    return {
      code: "USER_AUTHORIZATION_MISSING",
      message: "GitHub user authorization is unavailable",
    };
  }
  return { code: "UPSTREAM_UNAVAILABLE", message: "GitHub authorization could not be checked" };
}

interface UserRepositoryAccess {
  readonly status: "allowed" | "denied";
  readonly installationId: number;
  readonly repository?: GitHubRepository;
  readonly permissions: readonly RepositoryAction[];
}

async function userRepositoryAccess(
  config: GitHubAccessProviderConfig,
  userId: string,
  repositoryId: number,
  now: string,
): Promise<UserRepositoryAccess> {
  const accessToken = await config.userTokens.accessTokenFor(userId, now);
  if (!accessToken) throw new GitHubApiError(401, null);

  const installations = await config.api.listUserInstallations(accessToken);
  const installation = installations.find((item) => item.appId === config.appId);
  if (!installation || installation.suspendedAt !== null || !hasContentsRead(installation)) {
    return { status: "denied", installationId: installation?.id ?? 0, permissions: [] };
  }

  const repository = (
    await config.api.listInstallationRepositories(accessToken, installation.id)
  ).find((item) => item.id === repositoryId);
  if (!repository) return { status: "denied", installationId: installation.id, permissions: [] };

  if (!(await config.servicePolicy.allowsRepository(repository))) {
    return { status: "denied", installationId: installation.id, permissions: [] };
  }

  const permissions = permissionsFor(repository, installation);
  if (permissions.length === 0)
    return { status: "denied", installationId: installation.id, permissions };
  return { status: "allowed", installationId: installation.id, repository, permissions };
}

function bindingMatchesRepository(
  binding: RepositoryBinding,
  repository: GitHubRepository,
): boolean {
  return (
    binding.installationId > 0 &&
    binding.owner.toLowerCase() === repository.owner.toLowerCase() &&
    binding.name.toLowerCase() === repository.name.toLowerCase()
  );
}

async function loadAccessibleRepositories(
  config: GitHubAccessProviderConfig,
  userId: string,
  now: string,
): Promise<readonly AccessibleRepository[]> {
  const accessToken = await config.userTokens.accessTokenFor(userId, now);
  if (!accessToken) throw new GitHubApiError(401, null);
  const installations = await config.api.listUserInstallations(accessToken);
  const active = installations.filter(
    (installation) =>
      installation.appId === config.appId &&
      installation.suspendedAt === null &&
      hasContentsRead(installation),
  );
  const repositories: AccessibleRepository[] = [];
  for (const installation of active) {
    const installedRepositories = await config.api.listInstallationRepositories(
      accessToken,
      installation.id,
    );
    for (const repository of installedRepositories) {
      if (!(await config.servicePolicy.allowsRepository(repository))) continue;
      const role = roleFor(permissionsFor(repository, installation));
      if (!role) continue;
      repositories.push({
        repositoryId: repository.id,
        installationId: installation.id,
        owner: repository.owner,
        name: repository.name,
        private: repository.private,
        role,
      });
    }
  }
  return repositories;
}

/** Intersects current user repository permissions, the active App installation, and operator policy. */
export function createGitHubAccessProvider(config: GitHubAccessProviderConfig) {
  const now = config.now ?? (() => new Date());

  return {
    async listRepositories(userId: string) {
      try {
        return ok(await loadAccessibleRepositories(config, userId, now().toISOString()));
      } catch (error) {
        return err(mapAccessError(error));
      }
    },

    async authorize(
      userId: string,
      repositoryId: number,
      action: RepositoryAction,
    ): Promise<AccessDecision> {
      const checkedAt = now().getTime();
      const denied = (installationId = 0): AccessDecision =>
        decisionFor(repositoryId, installationId, [], checkedAt, false, action);
      if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) return denied();

      let access: UserRepositoryAccess;
      try {
        access = await userRepositoryAccess(
          config,
          userId,
          repositoryId,
          new Date(checkedAt).toISOString(),
        );
      } catch (error) {
        if (isUnavailable(error)) throw new GitHubAccessUnavailableError();
        return denied();
      }
      if (access.status !== "allowed" || !access.repository) return denied(access.installationId);

      let binding: RepositoryBinding | null;
      try {
        binding = await config.repositoryBindings.getByRepositoryId(repositoryId);
      } catch {
        throw new GitHubAccessUnavailableError();
      }
      // Unbound repositories may be listed for onboarding; a repository access decision
      // only authorizes a live, matching binding.
      if (
        !binding ||
        binding.status !== "active" ||
        !bindingMatchesRepository(binding, access.repository) ||
        binding.repositoryId !== repositoryId ||
        binding.installationId !== access.installationId
      ) {
        return denied(access.installationId);
      }
      return decisionFor(
        repositoryId,
        access.installationId,
        access.permissions,
        checkedAt,
        true,
        action,
      );
    },

    async checkBoundAccess(
      userId: string,
      repositoryId: number,
      instanceId: string,
      runtimeEpoch: number,
      requestedNow: string,
    ): Promise<FreshRepositoryAccessResult> {
      const instant = new Date(requestedNow);
      if (
        !Number.isFinite(instant.getTime()) ||
        !Number.isSafeInteger(repositoryId) ||
        repositoryId < 1 ||
        !Number.isSafeInteger(runtimeEpoch) ||
        runtimeEpoch < 0 ||
        !instanceId
      )
        return { status: "denied" };

      let access: UserRepositoryAccess;
      try {
        access = await userRepositoryAccess(config, userId, repositoryId, instant.toISOString());
      } catch (error) {
        if (isUnavailable(error)) return { status: "unavailable" };
        return { status: "denied" };
      }
      if (access.status !== "allowed" || !access.repository) return { status: "denied" };

      let binding: RepositoryBinding | null;
      try {
        binding = await config.repositoryBindings.getByRepositoryId(repositoryId);
      } catch {
        return { status: "unavailable" };
      }
      if (
        !binding ||
        binding.status !== "active" ||
        binding.repositoryId !== repositoryId ||
        binding.installationId !== access.installationId ||
        !bindingMatchesRepository(binding, access.repository) ||
        binding.instanceId !== instanceId ||
        binding.runtimeEpoch !== runtimeEpoch
      )
        return { status: "denied" };

      const permissions = access.permissions;
      const lifetimeSeconds = permissions.some((permission) => permission !== "read") ? 30 : 300;
      const checkedAt = instant.getTime();
      return {
        status: "allowed",
        repositoryId,
        installationId: access.installationId,
        instanceId: binding.instanceId,
        runtimeEpoch: binding.runtimeEpoch,
        authorizationRevision: binding.authorizationRevision,
        permissions,
        checkedAt,
        expiresAt: plusSeconds(instant, lifetimeSeconds),
      };
    },
  };
}
