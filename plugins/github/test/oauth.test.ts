import {
  generateToken,
  handleGithubCallbackWithCredentialSink,
  startGithubLogin,
  type LoginAttemptRecord,
  type LoginAttemptStore,
} from "@praetorium/auth";
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
    const attemptRecords = new Map<string, LoginAttemptRecord>();
    const attempts: LoginAttemptStore = {
      async save(record) {
        attemptRecords.set(record.state, record);
      },
      async consume(state) {
        const record = attemptRecords.get(state) ?? null;
        attemptRecords.delete(state);
        return record;
      },
    };
    const browserNonce = generateToken(256);
    const started = await startGithubLogin(provider, attempts, {
      browserNonce,
      redirectUri: "https://gateway.example.test/oauth/callback",
      redirectTo: "/repositories",
      scopes: [],
      now: "2026-10-17T00:00:00.000Z",
      attemptTtlSeconds: 300,
    });
    const authorize = new URL(started.authorizeUrl);
    const state = authorize.searchParams.get("state");
    if (!state) throw new Error("OAuth start omitted state");
    const attemptRecord = attemptRecords.get(state);
    if (!attemptRecord) throw new Error("OAuth start did not persist its attempt");
    expect(state).toBeTruthy();
    expect(authorize.searchParams.get("scope")).toBe("offline_access");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    let persisted: unknown;
    const result = await handleGithubCallbackWithCredentialSink(
      provider,
      attempts,
      "https://gateway.example.test/oauth/callback",
      { state, code: "one-time-code" },
      browserNonce,
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
      code_verifier: attemptRecord.codeVerifier,
    });
    expect(attemptRecord.browserNonceDigest).not.toBe(browserNonce);
    expect(
      String(
        requests[1]?.init.headers && new Headers(requests[1]?.init.headers).get("Authorization"),
      ),
    ).toBe("Bearer user-access-secret");
  });

  it("rejects a callback from a different browser before exchanging its code", async () => {
    let tokenExchangeCount = 0;
    let persisted = false;
    const provider = createGitHubAppOAuthProvider({
      clientId: "app-client-id",
      clientSecret: "app-client-secret",
      requestTimeoutMs: 1000,
      fetchImpl: async (input) => {
        if (String(input).includes("/login/oauth/access_token")) tokenExchangeCount += 1;
        return json({ access_token: "must-not-be-used" });
      },
    });
    const attempts = createInMemoryLoginAttemptStore();
    const browserNonce = generateToken(256);
    const started = await startGithubLogin(provider, attempts, {
      browserNonce,
      redirectUri: "https://gateway.example.test/oauth/callback",
      redirectTo: "/repositories",
      scopes: [],
      now: "2026-10-17T00:00:00.000Z",
      attemptTtlSeconds: 300,
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    if (!state) throw new Error("OAuth start omitted state");
    const result = await handleGithubCallbackWithCredentialSink(
      provider,
      attempts,
      "https://gateway.example.test/oauth/callback",
      { state, code: "attacker-code" },
      generateToken(256),
      "2026-10-17T00:00:00.000Z",
      {
        storeEncrypted: async () => {
          persisted = true;
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "BROWSER_BINDING_MISMATCH" },
    });
    expect(tokenExchangeCount).toBe(0);
    expect(persisted).toBe(false);
    expect(
      await handleGithubCallbackWithCredentialSink(
        provider,
        attempts,
        "https://gateway.example.test/oauth/callback",
        { state, code: "attacker-code" },
        browserNonce,
        "2026-10-17T00:00:00.000Z",
        {
          storeEncrypted: async () => {
            persisted = true;
          },
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "STATE_NOT_FOUND" } });
  });

  it("consumes provider-denial callbacks only when bound to their initiating browser", async () => {
    const provider = createGitHubAppOAuthProvider({
      clientId: "app-client-id",
      clientSecret: "app-client-secret",
      requestTimeoutMs: 1000,
      fetchImpl: async () => json({}),
    });
    const attempts = createInMemoryLoginAttemptStore();
    const browserNonce = generateToken(256);
    const started = await startGithubLogin(provider, attempts, {
      browserNonce,
      redirectUri: "https://gateway.example.test/oauth/callback",
      redirectTo: "/repositories",
      scopes: [],
      now: "2026-10-17T00:00:00.000Z",
      attemptTtlSeconds: 300,
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    if (!state) throw new Error("OAuth start omitted state");

    expect(
      await handleGithubCallbackWithCredentialSink(
        provider,
        attempts,
        "https://gateway.example.test/oauth/callback",
        { state, error: "access_denied" },
        generateToken(256),
        "2026-10-17T00:00:00.000Z",
        { storeEncrypted: async () => undefined },
      ),
    ).toMatchObject({ ok: false, error: { code: "BROWSER_BINDING_MISMATCH" } });
    expect(
      await handleGithubCallbackWithCredentialSink(
        provider,
        attempts,
        "https://gateway.example.test/oauth/callback",
        { state, error: "access_denied" },
        browserNonce,
        "2026-10-17T00:00:00.000Z",
        { storeEncrypted: async () => undefined },
      ),
    ).toMatchObject({ ok: false, error: { code: "STATE_NOT_FOUND" } });
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
