import { err, ok, type Result } from "../domain.js";
import { deriveCodeChallengeS256, generateCodeVerifier, generateState } from "../pkce.js";
import { constantTimeEqual } from "../digest.js";
import { base64UrlEncode } from "../random.js";
import {
  isLoginAttemptExpired,
  type LoginAttemptRecord,
  type LoginAttemptStore,
} from "./login-attempt.js";
import type { GitHubOAuthProvider, GitHubTokenResponse } from "./types.js";

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

const BROWSER_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

async function browserNonceDigest(browserNonce: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(browserNonce));
  return base64UrlEncode(new Uint8Array(digest));
}

export interface StartLoginInput {
  /** Raw 256-bit nonce carried only in the browser's HttpOnly callback cookie. */
  readonly browserNonce: string;
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
  if (!BROWSER_NONCE_PATTERN.test(input.browserNonce)) {
    throw new TypeError("browser-bound login nonce must contain 256 bits of URL-safe randomness");
  }
  if (
    !Number.isFinite(new Date(input.now).getTime()) ||
    !Number.isSafeInteger(input.attemptTtlSeconds) ||
    input.attemptTtlSeconds < 1 ||
    input.attemptTtlSeconds > 600
  ) {
    throw new TypeError("login attempts must use a valid time and lifetime of at most 600 seconds");
  }
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await deriveCodeChallengeS256(codeVerifier);

  const attempt: LoginAttemptRecord = {
    state,
    codeVerifier,
    browserNonceDigest: await browserNonceDigest(input.browserNonce),
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
  | "BROWSER_BINDING_MISMATCH"
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
    tokens: GitHubTokenResponse,
    issuedAt: string,
  ): Promise<void>;
}

type ConsumedAttemptResult =
  | { readonly ok: true; readonly attempt: LoginAttemptRecord }
  | { readonly ok: false; readonly error: GithubCallbackError };

async function consumeBrowserBoundAttempt(
  attemptStore: LoginAttemptStore,
  state: string,
  presentedBrowserNonce: string | null,
  now: string,
): Promise<ConsumedAttemptResult> {
  const attempt = await attemptStore.consume(state);
  if (!attempt) {
    return {
      ok: false,
      error: {
        code: "STATE_NOT_FOUND",
        message: "login attempt was not found, already used, or unknown",
      },
    };
  }
  if (isLoginAttemptExpired(attempt, now)) {
    return { ok: false, error: { code: "STATE_EXPIRED", message: "login attempt expired" } };
  }
  if (
    !presentedBrowserNonce ||
    !BROWSER_NONCE_PATTERN.test(presentedBrowserNonce) ||
    !constantTimeEqual(attempt.browserNonceDigest, await browserNonceDigest(presentedBrowserNonce))
  ) {
    return {
      ok: false,
      error: {
        code: "BROWSER_BINDING_MISMATCH",
        message: "login callback is not bound to this browser",
      },
    };
  }
  return { ok: true, attempt };
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
  presentedBrowserNonce: string | null,
  now: string,
): Promise<Result<ResolvedGithubLogin, GithubCallbackError>> {
  if (query.error) {
    if (!query.state)
      return err({ code: "MISSING_PARAMETERS", message: "callback is missing state" });
    const consumed = await consumeBrowserBoundAttempt(
      attemptStore,
      query.state,
      presentedBrowserNonce,
      now,
    );
    if (!consumed.ok) return err(consumed.error);
    return err({ code: "PROVIDER_DENIED", message: "GitHub denied the authorization request" });
  }

  if (!query.state || !query.code) {
    return err({ code: "MISSING_PARAMETERS", message: "callback is missing state or code" });
  }

  const consumed = await consumeBrowserBoundAttempt(
    attemptStore,
    query.state,
    presentedBrowserNonce,
    now,
  );
  if (!consumed.ok) return err(consumed.error);
  const { attempt } = consumed;

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
  presentedBrowserNonce: string | null,
  now: string,
  credentialSink: GitHubUserCredentialSink,
): Promise<Result<ResolvedGithubLogin, GithubCallbackError>> {
  if (query.error) {
    if (!query.state)
      return err({ code: "MISSING_PARAMETERS", message: "callback is missing state" });
    const consumed = await consumeBrowserBoundAttempt(
      attemptStore,
      query.state,
      presentedBrowserNonce,
      now,
    );
    if (!consumed.ok) return err(consumed.error);
    return err({ code: "PROVIDER_DENIED", message: "GitHub denied the authorization request" });
  }
  if (!query.state || !query.code) {
    return err({ code: "MISSING_PARAMETERS", message: "callback is missing state or code" });
  }

  const consumed = await consumeBrowserBoundAttempt(
    attemptStore,
    query.state,
    presentedBrowserNonce,
    now,
  );
  if (!consumed.ok) return err(consumed.error);
  const { attempt } = consumed;

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
    return err({
      code: "CREDENTIAL_STORAGE_FAILED",
      message: "GitHub credentials could not be stored securely",
    });
  }

  return ok({
    githubSubjectRef: profileResult.value.subject,
    login: profileResult.value.login,
    redirectTo: attempt.redirectTo,
  });
}
