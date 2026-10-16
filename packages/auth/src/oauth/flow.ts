import { err, ok, type Result } from "../domain.js";
import { deriveCodeChallengeS256, generateCodeVerifier, generateState } from "../pkce.js";
import { isLoginAttemptExpired, type LoginAttemptRecord, type LoginAttemptStore } from "./login-attempt.js";
import type { GitHubOAuthProvider } from "./types.js";

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

export interface StartLoginInput {
  readonly redirectUri: string;
  /** Already validated by the caller via `isSafeRelativeRedirect`. */
  readonly redirectTo: string;
  readonly scopes: readonly string[];
  readonly now: string;
  readonly attemptTtlSeconds: number;
}

export interface StartLoginResult {
  readonly authorizeUrl: string;
  readonly attempt: LoginAttemptRecord;
}

/** Begins a GitHub login: generates state/PKCE, persists the attempt, and builds the authorize URL. */
export async function startGithubLogin(
  provider: GitHubOAuthProvider,
  attemptStore: LoginAttemptStore,
  input: StartLoginInput,
): Promise<StartLoginResult> {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await deriveCodeChallengeS256(codeVerifier);

  const attempt: LoginAttemptRecord = {
    state,
    codeVerifier,
    redirectTo: input.redirectTo,
    createdAt: input.now,
    expiresAt: addSeconds(input.now, input.attemptTtlSeconds),
  };
  await attemptStore.save(attempt);

  const authorizeUrl = provider.buildAuthorizeUrl({
    state,
    codeChallenge,
    redirectUri: input.redirectUri,
    scopes: input.scopes,
  });

  return { authorizeUrl, attempt };
}

export type GithubCallbackErrorCode =
  | "MISSING_PARAMETERS"
  | "PROVIDER_DENIED"
  | "STATE_NOT_FOUND"
  | "STATE_EXPIRED"
  | "TOKEN_EXCHANGE_FAILED"
  | "PROFILE_FETCH_FAILED"
  | "CREDENTIAL_STORAGE_FAILED"
  | "ACCOUNT_SUSPENDED";

export interface GithubCallbackError {
  readonly code: GithubCallbackErrorCode;
  readonly message: string;
}

export interface GithubCallbackQuery {
  readonly state?: string | undefined;
  readonly code?: string | undefined;
  readonly error?: string | undefined;
}

export interface ResolvedGithubLogin {
  readonly githubSubjectRef: string;
  readonly login: string;
  readonly redirectTo: string;
}

export interface GitHubUserCredentialSink {
  /** Persists the token bundle encrypted; implementations must never store or log plaintext. */
  storeEncrypted(
    githubSubject: string,
    tokens: import("./types.js").GitHubTokenResponse,
    issuedAt: string,
  ): Promise<void>;
}

/**
 * Resolves a GitHub callback to exactly one identity, or a typed failure.
 * The state is consumed atomically before it is even checked for expiry, so
 * a replayed callback — success or failure — can never be processed twice.
 * The GitHub access token exists only for the duration of this call: it is
 * used once to fetch the profile and is never returned, stored, or logged.
 */
export async function handleGithubCallback(
  provider: GitHubOAuthProvider,
  attemptStore: LoginAttemptStore,
  redirectUri: string,
  query: GithubCallbackQuery,
  now: string,
): Promise<Result<ResolvedGithubLogin, GithubCallbackError>> {
  if (query.error) {
    return err({ code: "PROVIDER_DENIED", message: "GitHub denied the authorization request" });
  }

  if (!query.state || !query.code) {
    return err({ code: "MISSING_PARAMETERS", message: "callback is missing state or code" });
  }

  const attempt = await attemptStore.consume(query.state);
  if (!attempt) {
    return err({
      code: "STATE_NOT_FOUND",
      message: "login attempt was not found, already used, or unknown",
    });
  }

  if (isLoginAttemptExpired(attempt, now)) {
    return err({ code: "STATE_EXPIRED", message: "login attempt expired" });
  }

  const tokenResult = await provider.exchangeCode({
    code: query.code,
    redirectUri,
    codeVerifier: attempt.codeVerifier,
  });
  if (!tokenResult.ok) {
    return err({ code: "TOKEN_EXCHANGE_FAILED", message: "GitHub token exchange failed" });
  }

  const profileResult = await provider.fetchProfile(tokenResult.value.accessToken);
  if (!profileResult.ok) {
    return err({ code: "PROFILE_FETCH_FAILED", message: "GitHub profile lookup failed" });
  }

  if (profileResult.value.suspended) {
    return err({ code: "ACCOUNT_SUSPENDED", message: "GitHub account is suspended" });
  }

  return ok({
    githubSubjectRef: profileResult.value.subject,
    login: profileResult.value.login,
    redirectTo: attempt.redirectTo,
  });
}

/** Login variant for the Gateway: persists App user tokens through the encrypted Platform adapter. */
export async function handleGithubCallbackWithCredentialSink(
  provider: GitHubOAuthProvider,
  attemptStore: LoginAttemptStore,
  redirectUri: string,
  query: GithubCallbackQuery,
  now: string,
  credentialSink: GitHubUserCredentialSink,
): Promise<Result<ResolvedGithubLogin, GithubCallbackError>> {
  if (query.error) {
    return err({ code: "PROVIDER_DENIED", message: "GitHub denied the authorization request" });
  }
  if (!query.state || !query.code) {
    return err({ code: "MISSING_PARAMETERS", message: "callback is missing state or code" });
  }

  const attempt = await attemptStore.consume(query.state);
  if (!attempt) {
    return err({ code: "STATE_NOT_FOUND", message: "login attempt was not found, already used, or unknown" });
  }
  if (isLoginAttemptExpired(attempt, now)) {
    return err({ code: "STATE_EXPIRED", message: "login attempt expired" });
  }

  const tokenResult = await provider.exchangeCode({
    code: query.code,
    redirectUri,
    codeVerifier: attempt.codeVerifier,
  });
  if (!tokenResult.ok) {
    return err({ code: "TOKEN_EXCHANGE_FAILED", message: "GitHub token exchange failed" });
  }

  const profileResult = await provider.fetchProfile(tokenResult.value.accessToken);
  if (!profileResult.ok) {
    return err({ code: "PROFILE_FETCH_FAILED", message: "GitHub profile lookup failed" });
  }
  if (profileResult.value.suspended) {
    return err({ code: "ACCOUNT_SUSPENDED", message: "GitHub account is suspended" });
  }

  try {
    await credentialSink.storeEncrypted(profileResult.value.subject, tokenResult.value, now);
  } catch {
    return err({ code: "CREDENTIAL_STORAGE_FAILED", message: "GitHub credentials could not be stored securely" });
  }

  return ok({
    githubSubjectRef: profileResult.value.subject,
    login: profileResult.value.login,
    redirectTo: attempt.redirectTo,
  });
}
