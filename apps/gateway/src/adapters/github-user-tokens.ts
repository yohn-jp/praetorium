import type { GitHubTokenResponse, TokenVault } from "@praetorium/auth";
import type { GitHubUserTokenSource } from "@praetorium/github";

export interface GitHubTokenPersistence {
  storeEncrypted(subject: string, tokens: GitHubTokenResponse, issuedAt: string): Promise<void>;
}

interface StoredTokenRecord {
  readonly encrypted: { readonly version: 1; readonly keyId: string; readonly iv: string; readonly ciphertext: string };
  readonly accessTokenExpiresAt: string | null;
  readonly refreshTokenExpiresAt: string | null;
  readonly revision: number;
}

interface TokenState extends StoredTokenRecord {
  readonly refreshLockedUntil: string | null;
  readonly refreshLockId: string | null;
}

async function call<T>(namespace: DurableObjectNamespace, subject: string, path: string, body: unknown): Promise<T> {
  const stub = namespace.get(namespace.idFromName(subject));
  const response = await stub.fetch(`https://user-auth-state${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("GitHub user token storage unavailable");
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function contextFor(subject: string): string {
  return `github-user-token:${subject}`;
}

function parseTokens(value: string): GitHubTokenResponse {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { accessToken?: unknown }).accessToken !== "string") {
    throw new Error("encrypted GitHub token record is malformed");
  }
  return parsed as GitHubTokenResponse;
}

function isFresh(expiry: string | null, now: string): boolean {
  return expiry !== null && Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) > Date.parse(now) + 60_000;
}

/** OAuth credentials are encrypted before they enter the per-user Durable Object. */
export function createDurableObjectGitHubUserTokenStore(
  namespace: DurableObjectNamespace,
  vault: TokenVault,
  oauth: {
    refreshUserToken(refreshToken: string): Promise<{ readonly ok: true; readonly value: GitHubTokenResponse } | { readonly ok: false }>;
  },
): GitHubTokenPersistence & GitHubUserTokenSource {
  return {
    async storeEncrypted(subject, tokens, issuedAt) {
      const encrypted = await vault.seal(JSON.stringify(tokens), contextFor(subject));
      await call(namespace, subject, "/github-token/store", {
        encrypted,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt ?? null,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt ?? null,
        issuedAt,
      });
    },

    async accessTokenFor(subject, now) {
      const { state } = await call<{ readonly state: TokenState | null }>(namespace, subject, "/github-token/get", {});
      if (!state) return null;
      const current = parseTokens(await vault.open(state.encrypted, contextFor(subject)));
      if (isFresh(current.accessTokenExpiresAt ?? null, now)) return current.accessToken;
      if (!current.refreshToken || !isFresh(current.refreshTokenExpiresAt ?? null, now)) return null;

      const lockId = crypto.randomUUID();
      const lockUntil = new Date(Date.parse(now) + 20_000).toISOString();
      const { acquired } = await call<{ readonly acquired: boolean }>(namespace, subject, "/github-token/lock", {
        lockId,
        lockUntil,
        now,
        expectedRevision: state.revision,
      });
      if (!acquired) {
        // A concurrent request is refreshing. Re-read the serialized record a few times; never use an expired token.
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
          const { state: newer } = await call<{ readonly state: TokenState | null }>(namespace, subject, "/github-token/get", {});
          if (newer && newer.revision > state.revision) {
            const tokens = parseTokens(await vault.open(newer.encrypted, contextFor(subject)));
            if (isFresh(tokens.accessTokenExpiresAt ?? null, now)) return tokens.accessToken;
          }
        }
        return null;
      }

      try {
        const refreshed = await oauth.refreshUserToken(current.refreshToken);
        if (!refreshed.ok) return null;
        const encrypted = await vault.seal(JSON.stringify(refreshed.value), contextFor(subject));
        const { stored } = await call<{ readonly stored: boolean }>(namespace, subject, "/github-token/rotate", {
          lockId,
          expectedRevision: state.revision,
          encrypted,
          accessTokenExpiresAt: refreshed.value.accessTokenExpiresAt ?? null,
          refreshTokenExpiresAt: refreshed.value.refreshTokenExpiresAt ?? null,
        });
        if (stored) return refreshed.value.accessToken;
        const { state: winner } = await call<{ readonly state: TokenState | null }>(namespace, subject, "/github-token/get", {});
        if (!winner) return null;
        const winnerTokens = parseTokens(await vault.open(winner.encrypted, contextFor(subject)));
        return isFresh(winnerTokens.accessTokenExpiresAt ?? null, now) ? winnerTokens.accessToken : null;
      } finally {
        await call(namespace, subject, "/github-token/unlock", { lockId }).catch(() => undefined);
      }
    },
  };
}
