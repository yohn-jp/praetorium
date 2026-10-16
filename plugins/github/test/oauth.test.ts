import { handleGithubCallbackWithCredentialSink } from "@praetorium/auth";
import { createInMemoryLoginAttemptStore } from "@praetorium/auth/testing";
import { describe, expect, it } from "vitest";
import { createGitHubAppOAuthProvider } from "../src/oauth.js";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHub App user OAuth", () => {
  it("requests offline token rotation with PKCE and encryptable credential handoff", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = createGitHubAppOAuthProvider({
      clientId: "app-client-id",
      clientSecret: "app-client-secret",
      requestTimeoutMs: 1000,
      now: () => new Date("2026-10-17T00:00:00.000Z"),
      fetchImpl: async (input, init = {}) => {
        requests.push({ url: String(input), init });
        if (String(input).includes("/login/oauth/access_token")) {
          return json({
            access_token: "user-access-secret",
            refresh_token: "user-refresh-secret",
            expires_in: 3600,
            refresh_token_expires_in: 15_552_000,
          });
        }
        return json({
          id: 4242,
          login: "sophia",
          email: "sophia@example.test",
          suspended_at: null,
        });
      },
    });
    const authorize = new URL(
      provider.buildAuthorizeUrl({
        state: "state-1",
        codeChallenge: "challenge",
        redirectUri: "https://gateway.example.test/oauth/callback",
        scopes: [],
      }),
    );
    expect(authorize.searchParams.get("scope")).toBe("offline_access");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

    const attempts = createInMemoryLoginAttemptStore();
    await attempts.save({
      state: "state-1",
      codeVerifier: "pkce-verifier",
      redirectTo: "/repositories",
      createdAt: "2026-10-17T00:00:00.000Z",
      expiresAt: "2026-10-17T00:05:00.000Z",
    });
    let persisted: unknown;
    const result = await handleGithubCallbackWithCredentialSink(
      provider,
      attempts,
      "https://gateway.example.test/oauth/callback",
      { state: "state-1", code: "one-time-code" },
      "2026-10-17T00:00:00.000Z",
      {
        storeEncrypted: async (subject, tokens, issuedAt) => {
          persisted = { subject, tokens, issuedAt };
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      value: { githubSubjectRef: "4242", login: "sophia", redirectTo: "/repositories" },
    });
    expect(JSON.stringify(result)).not.toContain("user-access-secret");
    expect(JSON.stringify(result)).not.toContain("user-refresh-secret");
    expect(persisted).toMatchObject({
      subject: "4242",
      tokens: {
        accessToken: "user-access-secret",
        refreshToken: "user-refresh-secret",
        accessTokenExpiresAt: "2026-10-17T01:00:00.000Z",
        refreshTokenExpiresAt: "2027-04-15T00:00:00.000Z",
      },
    });
    expect(requests).toHaveLength(2);
    const exchangeBody = JSON.parse(String(requests[0]?.init.body)) as Record<string, string>;
    expect(exchangeBody).toMatchObject({
      grant_type: "authorization_code",
      code_verifier: "pkce-verifier",
    });
    expect(
      String(
        requests[1]?.init.headers && new Headers(requests[1]?.init.headers).get("Authorization"),
      ),
    ).toBe("Bearer user-access-secret");
  });

  it("rotates user tokens using the App refresh grant without returning either secret", async () => {
    let body: Record<string, string> | null = null;
    const provider = createGitHubAppOAuthProvider({
      clientId: "app-client-id",
      clientSecret: "app-client-secret",
      requestTimeoutMs: 1000,
      now: () => new Date("2026-10-17T00:00:00.000Z"),
      fetchImpl: async (_input, init = {}) => {
        body = JSON.parse(String(init.body)) as Record<string, string>;
        return json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        });
      },
    });
    const refreshed = await provider.refreshUserToken("previous-refresh");
    expect(body).toMatchObject({ grant_type: "refresh_token", refresh_token: "previous-refresh" });
    expect(refreshed).toMatchObject({
      ok: true,
      value: { accessToken: "rotated-access", refreshToken: "rotated-refresh" },
    });
  });
});
