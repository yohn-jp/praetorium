import type { GitHubRestClient } from "./api.js";
import { GitHubApiError } from "./api.js";
import { createGitHubAppJwt } from "./app-jwt.js";

export type InstallationTokenPermission = "read" | "write";

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly installationId: number;
  readonly repositoryId: number;
  readonly permission: InstallationTokenPermission;
}

export interface GitHubInstallationTokenIssuer {
  issue(
    installationId: number,
    repositoryId: number,
    permission: InstallationTokenPermission,
    now: string,
  ): Promise<InstallationToken>;
}

export interface GitHubInstallationTokenIssuerConfig {
  readonly appId: number;
  readonly privateKeyPem: string;
  readonly client: GitHubRestClient;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Mints opaque installation credentials scoped to one repository and Contents permission. */
export function createGitHubInstallationTokenIssuer(
  config: GitHubInstallationTokenIssuerConfig,
): GitHubInstallationTokenIssuer {
  return {
    async issue(installationId, repositoryId, permission, now) {
      if (
        !Number.isSafeInteger(installationId) ||
        installationId < 1 ||
        !Number.isSafeInteger(repositoryId) ||
        repositoryId < 1
      )
        throw new TypeError("installation and repository IDs must be positive integers");

      const instant = new Date(now);
      if (!Number.isFinite(instant.getTime())) throw new TypeError("now must be a valid timestamp");
      const jwt = await createGitHubAppJwt(config.appId, config.privateKeyPem, instant);
      const response = await config.client.request(
        `/app/installations/${installationId}/access_tokens`,
        jwt,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repository_ids: [repositoryId],
            permissions: { contents: permission },
          }),
        },
      );
      const body = response.body;
      if (
        !isObject(body) ||
        typeof body.token !== "string" ||
        body.token.length === 0 ||
        typeof body.expires_at !== "string" ||
        !isObject(body.permissions) ||
        body.permissions.contents !== permission ||
        !Array.isArray(body.repositories)
      )
        throw new GitHubApiError(502, null);

      const returnedRepositories = body.repositories.filter(
        (repository) => isObject(repository) && repository.id === repositoryId,
      );
      if (returnedRepositories.length !== 1 || body.repositories.length !== 1) {
        throw new GitHubApiError(502, null);
      }
      const expiresAt = new Date(body.expires_at);
      const nowMs = instant.getTime();
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= nowMs ||
        expiresAt.getTime() > nowMs + 3605_000
      )
        throw new GitHubApiError(502, null);

      return {
        token: body.token,
        expiresAt: expiresAt.toISOString(),
        installationId,
        repositoryId,
        permission,
      };
    },
  };
}
