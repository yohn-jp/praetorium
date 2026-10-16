import { err, ok, type Result } from "../domain.js";
import type {
  AuthorizeUrlParams,
  ExchangeCodeParams,
  GitHubOAuthProvider,
  GitHubTokenResponse,
  GitHubProfile,
  OAuthProviderError,
} from "./types.js";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

export interface GitHubOAuthProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly requestTimeoutMs: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Real GitHub identity provider. Never logs the code, verifier, or access token it handles. */
export function createGitHubOAuthProvider(config: GitHubOAuthProviderConfig): GitHubOAuthProvider {
  const doFetch = config.fetchImpl ?? fetch;

  async function fetchJson(
    url: string,
    init: RequestInit,
  ): Promise<Result<JsonResponse, OAuthProviderError>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await doFetch(url, { ...init, signal: controller.signal });
      const body: unknown = await response.json();
      return ok({ status: response.status, body });
    } catch (error) {
      if (isAbortError(error)) {
        return err({ code: "TIMEOUT", message: "GitHub request timed out" });
      }
      return err({ code: "UPSTREAM_ERROR", message: "GitHub request failed" });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    buildAuthorizeUrl(params: AuthorizeUrlParams): string {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", params.redirectUri);
      url.searchParams.set("state", params.state);
      url.searchParams.set("code_challenge", params.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("scope", params.scopes.join(" "));
      url.searchParams.set("allow_signup", "false");
      return url.toString();
    },

    async exchangeCode(
      params: ExchangeCodeParams,
    ): Promise<Result<GitHubTokenResponse, OAuthProviderError>> {
      const result = await fetchJson(TOKEN_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code: params.code,
          redirect_uri: params.redirectUri,
          code_verifier: params.codeVerifier,
          grant_type: "authorization_code",
        }),
      });
      if (!result.ok) {
        return result;
      }

      const body = result.value.body as { access_token?: unknown; error?: unknown };
      if (result.value.status !== 200 || typeof body.access_token !== "string") {
        const reason = typeof body.error === "string" ? body.error : "unknown_error";
        return err({ code: "INVALID_GRANT", message: `GitHub rejected the code: ${reason}` });
      }

      return ok({ accessToken: body.access_token });
    },

    async fetchProfile(accessToken: string): Promise<Result<GitHubProfile, OAuthProviderError>> {
      const result = await fetchJson(USER_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "arcadia-platform-gateway",
        },
      });
      if (!result.ok) {
        return result;
      }

      if (result.value.status === 403) {
        return err({ code: "DENIED", message: "GitHub denied access to the profile" });
      }

      const body = result.value.body as {
        id?: unknown;
        login?: unknown;
        email?: unknown;
        suspended_at?: unknown;
      };
      if (
        result.value.status !== 200 ||
        typeof body.id !== "number" ||
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
