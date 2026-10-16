import type {
  AuthorizeUrlParams,
  ExchangeCodeParams,
  GitHubOAuthProvider,
  GitHubProfile,
  GitHubTokenResponse,
  OAuthProviderError,
} from "@praetorium/auth";
import { err, ok, type Result } from "@praetorium/domain";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const API_VERSION = "2026-03-10";

export interface GitHubAppOAuthProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly requestTimeoutMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export interface GitHubAppOAuthProvider extends GitHubOAuthProvider {
  refreshUserToken(refreshToken: string): Promise<Result<GitHubTokenResponse, OAuthProviderError>>;
}

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toExpiry(value: unknown, now: Date): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  return new Date(now.getTime() + value * 1000).toISOString();
}

function parseTokenResponse(value: unknown, now: Date): GitHubTokenResponse | null {
  if (
    !isObject(value) ||
    typeof value.access_token !== "string" ||
    value.access_token.length === 0
  ) {
    return null;
  }
  const accessTokenExpiresAt = toExpiry(value.expires_in, now);
  const refreshTokenExpiresAt = toExpiry(value.refresh_token_expires_in, now);
  return {
    accessToken: value.access_token,
    refreshToken: typeof value.refresh_token === "string" ? value.refresh_token : null,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** GitHub App user authorization. It never requests broad OAuth scopes; only offline_access is used for rotation. */
export function createGitHubAppOAuthProvider(
  config: GitHubAppOAuthProviderConfig,
): GitHubAppOAuthProvider {
  if (!config.clientId || !config.clientSecret || config.requestTimeoutMs < 1) {
    throw new TypeError("GitHub App OAuth configuration is incomplete");
  }
  const doFetch = config.fetchImpl ?? fetch;
  const now = config.now ?? (() => new Date());

  async function fetchJson(
    url: string,
    init: RequestInit,
  ): Promise<Result<JsonResponse, OAuthProviderError>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await doFetch(url, { ...init, signal: controller.signal });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return ok({ status: response.status, body });
    } catch (error) {
      if (isAbortError(error)) return err({ code: "TIMEOUT", message: "GitHub request timed out" });
      return err({ code: "UPSTREAM_ERROR", message: "GitHub request failed" });
    } finally {
      clearTimeout(timer);
    }
  }

  async function exchange(
    parameters: Record<string, string>,
  ): Promise<Result<GitHubTokenResponse, OAuthProviderError>> {
    const result = await fetchJson(TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...parameters,
      }),
    });
    if (!result.ok) return result;
    const tokens = parseTokenResponse(result.value.body, now());
    if (result.value.status !== 200 || !tokens) {
      return err({ code: "INVALID_GRANT", message: "GitHub rejected the authorization grant" });
    }
    return ok(tokens);
  }

  return {
    buildAuthorizeUrl(params: AuthorizeUrlParams): string {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", params.redirectUri);
      url.searchParams.set("state", params.state);
      url.searchParams.set("code_challenge", params.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("scope", "offline_access");
      url.searchParams.set("allow_signup", "false");
      return url.toString();
    },

    exchangeCode(params: ExchangeCodeParams) {
      return exchange({
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier,
        grant_type: "authorization_code",
      });
    },

    refreshUserToken(refreshToken: string) {
      if (!refreshToken) {
        return Promise.resolve(
          err({ code: "INVALID_GRANT", message: "GitHub refresh token is invalid" }),
        );
      }
      return exchange({ refresh_token: refreshToken, grant_type: "refresh_token" });
    },

    async fetchProfile(accessToken: string): Promise<Result<GitHubProfile, OAuthProviderError>> {
      const result = await fetchJson(USER_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "praetorium-gateway",
          "X-GitHub-Api-Version": API_VERSION,
        },
      });
      if (!result.ok) return result;
      if (result.value.status === 401 || result.value.status === 403) {
        return err({ code: "DENIED", message: "GitHub denied access to the user profile" });
      }
      const body = result.value.body;
      if (
        result.value.status !== 200 ||
        !isObject(body) ||
        typeof body.id !== "number" ||
        !Number.isSafeInteger(body.id) ||
        typeof body.login !== "string"
      ) {
        return err({ code: "UPSTREAM_ERROR", message: "GitHub profile response was malformed" });
      }
      return ok({
        subject: String(body.id),
        login: body.login,
        verifiedEmail: typeof body.email === "string" ? body.email : null,
        suspended: typeof body.suspended_at === "string",
      });
    },
  };
}
