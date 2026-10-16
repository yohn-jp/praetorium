import type {
  GitHubAccessApi,
  GitHubInstallation,
  GitHubRepository,
  GitHubRepositoryId,
  GitHubInstallationId,
} from "./types.js";

export const GITHUB_API_VERSION = "2026-03-10";
const API_ORIGIN = "https://api.github.com";

export interface GitHubRestClient {
  request(
    path: string,
    token: string,
    init?: RequestInit,
  ): Promise<{ readonly status: number; readonly body: unknown; readonly headers: Headers }>;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, retryAfterSeconds: number | null) {
    super("GitHub API request failed");
    this.name = "GitHubApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface GitHubRestClientConfig {
  readonly requestTimeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

function asRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, 3600) : null;
}

export function createGitHubRestClient(config: GitHubRestClientConfig): GitHubRestClient {
  const doFetch = config.fetchImpl ?? fetch;
  return {
    async request(path, token, init = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      try {
        const response = await doFetch(new URL(path, API_ORIGIN), {
          ...init,
          signal: controller.signal,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "praetorium-github-app",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            ...(init.headers ?? {}),
          },
        });
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        if (!response.ok) {
          const reset = response.headers.get("x-ratelimit-reset");
          const remaining = response.headers.get("x-ratelimit-remaining");
          const retryAfter = asRetryAfter(response.headers.get("retry-after"));
          const rateLimited =
            response.status === 429 ||
            (response.status === 403 && (remaining === "0" || retryAfter !== null));
          const untilReset = reset
            ? Math.max(1, Number(reset) - Math.floor(Date.now() / 1000))
            : null;
          throw new GitHubApiError(
            rateLimited ? 429 : response.status,
            retryAfter ??
              (rateLimited && Number.isFinite(untilReset) ? Math.min(untilReset!, 3600) : null),
          );
        }
        return { status: response.status, body, headers: response.headers };
      } catch (error) {
        if (error instanceof GitHubApiError) throw error;
        if (error instanceof Error && error.name === "AbortError")
          throw new GitHubApiError(408, null);
        throw new GitHubApiError(0, null);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePermissions(value: unknown): Readonly<Record<string, string>> {
  if (!isObject(value)) return {};
  const permissions: Record<string, string> = {};
  for (const [name, permission] of Object.entries(value)) {
    if (typeof permission === "string") permissions[name] = permission;
  }
  return permissions;
}

function parseInstallation(value: unknown): GitHubInstallation | null {
  if (
    !isObject(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    typeof value.app_id !== "number" ||
    !Number.isSafeInteger(value.app_id) ||
    (value.repository_selection !== "all" && value.repository_selection !== "selected")
  )
    return null;
  return {
    id: value.id,
    appId: value.app_id,
    suspendedAt: typeof value.suspended_at === "string" ? value.suspended_at : null,
    repositorySelection: value.repository_selection,
    permissions: parsePermissions(value.permissions),
  };
}

function parseRepository(value: unknown): GitHubRepository | null {
  if (
    !isObject(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    typeof value.name !== "string" ||
    typeof value.full_name !== "string" ||
    typeof value.private !== "boolean" ||
    !isObject(value.owner) ||
    typeof value.owner.login !== "string"
  )
    return null;
  const permissions = isObject(value.permissions) ? value.permissions : {};
  const userPermissions: Record<string, boolean> = {};
  for (const name of ["admin", "maintain", "push", "triage", "pull"] as const) {
    if (typeof permissions[name] === "boolean") userPermissions[name] = permissions[name];
  }
  return {
    id: value.id as GitHubRepositoryId,
    name: value.name,
    fullName: value.full_name,
    owner: value.owner.login,
    private: value.private,
    permissions: userPermissions,
  };
}

async function listPages<T>(load: (page: number) => Promise<readonly T[]>): Promise<readonly T[]> {
  const all: T[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const current = await load(page);
    all.push(...current);
    if (current.length < 100) return all;
  }
  throw new GitHubApiError(422, null);
}

export function createGitHubAccessApi(client: GitHubRestClient): GitHubAccessApi {
  return {
    listUserInstallations: (accessToken) =>
      listPages(async (page) => {
        const response = await client.request(
          `/user/installations?per_page=100&page=${page}`,
          accessToken,
        );
        if (!isObject(response.body) || !Array.isArray(response.body.installations)) {
          throw new GitHubApiError(502, null);
        }
        const values = response.body.installations.map(parseInstallation);
        if (values.some((value) => value === null)) throw new GitHubApiError(502, null);
        return values as GitHubInstallation[];
      }),
    listInstallationRepositories: (accessToken, installationId: GitHubInstallationId) =>
      listPages(async (page) => {
        const response = await client.request(
          `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
          accessToken,
        );
        if (!isObject(response.body) || !Array.isArray(response.body.repositories)) {
          throw new GitHubApiError(502, null);
        }
        const values = response.body.repositories.map(parseRepository);
        if (values.some((value) => value === null)) throw new GitHubApiError(502, null);
        return values as GitHubRepository[];
      }),
  };
}
