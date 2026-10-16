import { err, ok } from "../domain.js";
import type { GitHubOAuthProvider, GitHubProfile } from "../oauth/types.js";

export interface FakeGithubAccount {
  readonly code: string;
  readonly profile: GitHubProfile;
}

export interface FakeGitHubOAuthProviderOptions {
  readonly accounts?: readonly FakeGithubAccount[];
  readonly deniedCodes?: readonly string[];
  readonly timeoutCodes?: readonly string[];
  readonly errorCodes?: readonly string[];
}

/**
 * Deterministic GitHub provider double covering every success/error path
 * from issue #17 by table lookup on the authorization `code`, with no
 * network access.
 */
export function createFakeGitHubOAuthProvider(
  options: FakeGitHubOAuthProviderOptions = {},
): GitHubOAuthProvider {
  const accountsByCode = new Map(options.accounts?.map((account) => [account.code, account]) ?? []);
  const denied = new Set(options.deniedCodes ?? []);
  const timeouts = new Set(options.timeoutCodes ?? []);
  const upstreamErrors = new Set(options.errorCodes ?? []);

  return {
    buildAuthorizeUrl(params) {
      const url = new URL("https://fake-github.test/login/oauth/authorize");
      url.searchParams.set("state", params.state);
      url.searchParams.set("code_challenge", params.codeChallenge);
      url.searchParams.set("redirect_uri", params.redirectUri);
      url.searchParams.set("scope", params.scopes.join(" "));
      return url.toString();
    },

    async exchangeCode(params) {
      if (timeouts.has(params.code)) {
        return err({ code: "TIMEOUT", message: "fake timeout" });
      }
      if (upstreamErrors.has(params.code)) {
        return err({ code: "UPSTREAM_ERROR", message: "fake upstream error" });
      }
      if (denied.has(params.code) || !accountsByCode.has(params.code)) {
        return err({ code: "INVALID_GRANT", message: "fake invalid grant" });
      }
      return ok({ accessToken: `fake-access-token:${params.code}` });
    },

    async fetchProfile(accessToken) {
      const code = accessToken.startsWith("fake-access-token:")
        ? accessToken.slice("fake-access-token:".length)
        : "";
      const account = accountsByCode.get(code);
      if (!account) {
        return err({ code: "UPSTREAM_ERROR", message: "fake profile not found" });
      }
      return ok(account.profile);
    },
  };
}
