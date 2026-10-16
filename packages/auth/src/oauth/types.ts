import type { Result } from "../domain.js";

/**
 * GitHub's immutable numeric account id, stringified. `login` is the
 * mutable handle and must never be used as the identity key — a rename
 * must resolve to the same platform `User`.
 */
export interface GitHubProfile {
  readonly subject: string;
  readonly login: string;
  readonly verifiedEmail: string | null;
  readonly suspended: boolean;
}

export interface GitHubTokenResponse {
  readonly accessToken: string;
  readonly refreshToken?: string | null;
  readonly accessTokenExpiresAt?: string | null;
  readonly refreshTokenExpiresAt?: string | null;
}

export type OAuthProviderErrorCode = "TIMEOUT" | "DENIED" | "UPSTREAM_ERROR" | "INVALID_GRANT";

export interface OAuthProviderError {
  readonly code: OAuthProviderErrorCode;
  readonly message: string;
}

export interface AuthorizeUrlParams {
  readonly state: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}

export interface ExchangeCodeParams {
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}

/**
 * Isolation boundary for the identity provider: a future non-GitHub
 * provider, or a deterministic test double, substitutes behind this
 * interface without touching login-attempt or session orchestration.
 */
export interface GitHubOAuthProvider {
  buildAuthorizeUrl(params: AuthorizeUrlParams): string;
  exchangeCode(
    params: ExchangeCodeParams,
  ): Promise<Result<GitHubTokenResponse, OAuthProviderError>>;
  fetchProfile(accessToken: string): Promise<Result<GitHubProfile, OAuthProviderError>>;
}
