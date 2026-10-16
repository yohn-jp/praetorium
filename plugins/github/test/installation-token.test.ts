import { describe, expect, it } from "vitest";
import { GitHubApiError, createGitHubRestClient } from "../src/api.js";
import {
  createGitHubInstallationTokenIssuer,
  createGitHubInstallationTokenRevoker,
} from "../src/installation-token.js";
import type { GitHubRestClient } from "../src/api.js";

async function privateKeyPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const encoded = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const binary = String.fromCharCode(...encoded);
  const base64 =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

describe("GitHub installation token scope", () => {
  it("mints opaque credentials for one numeric repository and the minimum Contents permission", async () => {
    const requests: Array<{ path: string; token: string; init?: RequestInit }> = [];
    const client: GitHubRestClient = {
      request: async (path, token, init) => {
        requests.push({ path, token, init });
        return {
          status: 201,
          headers: new Headers(),
          body: {
            token: "opaque-github-token",
            expires_at: "2026-10-17T01:00:00.000Z",
            permissions: { contents: "write" },
            repositories: [{ id: 1001 }],
          },
        };
      },
    };
    const issuer = createGitHubInstallationTokenIssuer({
      appId: 41,
      privateKeyPem: await privateKeyPem(),
      client,
    });
    const credential = await issuer.issue(71, 1001, "write", "2026-10-17T00:00:00.000Z");

    expect(credential).toMatchObject({
      token: "opaque-github-token",
      installationId: 71,
      repositoryId: 1001,
      permission: "write",
      expiresAt: "2026-10-17T01:00:00.000Z",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/app/installations/71/access_tokens");
    const body = JSON.parse(String(requests[0]?.init?.body)) as {
      repository_ids: number[];
      permissions: Record<string, string>;
    };
    expect(body).toEqual({ repository_ids: [1001], permissions: { contents: "write" } });
    expect(requests[0]?.token).not.toContain("opaque-github-token");
  });

  it("revokes a stored installation token with its own bearer authority", async () => {
    const installationToken = {
      token: "stored-installation-token",
      expiresAt: "2026-10-17T01:00:00.000Z",
      installationId: 71,
      repositoryId: 1001,
      permission: "write" as const,
    };
    let captured: Request | undefined;
    const client = createGitHubRestClient({
      requestTimeoutMs: 1_000,
      fetchImpl: async (input, init) => {
        captured = new Request(input, init);
        return new Response(null, { status: 204 });
      },
    });
    const revoker = createGitHubInstallationTokenRevoker({ client });

    await expect(revoker.revoke(installationToken)).resolves.toBeUndefined();

    expect(captured?.url).toBe("https://api.github.com/installation/token");
    expect(captured?.method).toBe("DELETE");
    expect(captured?.headers.get("Authorization")).toBe("Bearer stored-installation-token");
    expect(captured?.headers.get("Accept")).toBe("application/vnd.github+json");
    expect(captured?.headers.get("X-GitHub-Api-Version")).toBe("2026-03-10");
    expect(captured?.headers.get("Content-Type")).toBeNull();
  });

  it("keeps undocumented 401 responses as typed failures without exposing the token", async () => {
    const token = "sensitive-installation-token";
    const client: GitHubRestClient = {
      request: async () => {
        throw new GitHubApiError(401, null);
      },
    };
    const revoker = createGitHubInstallationTokenRevoker({ client });
    const result = await revoker.revoke({
      token,
      expiresAt: "2026-10-17T01:00:00.000Z",
      installationId: 71,
      repositoryId: 1001,
      permission: "write",
    }).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(GitHubApiError);
    expect(result).toMatchObject({ status: 401, retryAfterSeconds: null });
    expect((result as Error).message).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("preserves transient rate and network failures as typed, redacted errors", async () => {
    const token = "sensitive-installation-token";
    const rateLimitedClient: GitHubRestClient = {
      request: async () => {
        throw new GitHubApiError(429, 30);
      },
    };
    const rateLimited = await createGitHubInstallationTokenRevoker({ client: rateLimitedClient })
      .revoke({
        token,
        expiresAt: "2026-10-17T01:00:00.000Z",
        installationId: 71,
        repositoryId: 1001,
        permission: "write",
      })
      .catch((error: unknown) => error);
    expect(rateLimited).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    expect((rateLimited as Error).message).not.toContain(token);

    const networkClient = createGitHubRestClient({
      requestTimeoutMs: 1_000,
      fetchImpl: async () => {
        throw new TypeError(`network failed for ${token}`);
      },
    });
    const network = await createGitHubInstallationTokenRevoker({ client: networkClient })
      .revoke({
        token,
        expiresAt: "2026-10-17T01:00:00.000Z",
        installationId: 71,
        repositoryId: 1001,
        permission: "write",
      })
      .catch((error: unknown) => error);
    expect(network).toBeInstanceOf(GitHubApiError);
    expect(network).toMatchObject({ status: 0, retryAfterSeconds: null });
    expect((network as Error).message).not.toContain(token);
    expect(JSON.stringify(network)).not.toContain(token);
  });

  it("rejects non-204 success responses instead of claiming revocation", async () => {
    const revoker = createGitHubInstallationTokenRevoker({
      client: {
        request: async () => ({ status: 200, headers: new Headers(), body: null }),
      },
    });
    await expect(revoker.revoke({
      token: "stored-installation-token",
      expiresAt: "2026-10-17T01:00:00.000Z",
      installationId: 71,
      repositoryId: 1001,
      permission: "write",
    })).rejects.toMatchObject({ status: 200 });
  });

  it("rejects a response that widens repository or permission scope", async () => {
    const client: GitHubRestClient = {
      request: async () => ({
        status: 201,
        headers: new Headers(),
        body: {
          token: "opaque-github-token",
          expires_at: "2026-10-17T01:00:00.000Z",
          permissions: { contents: "write" },
          repositories: [{ id: 1001 }, { id: 1002 }],
        },
      }),
    };
    const issuer = createGitHubInstallationTokenIssuer({
      appId: 41,
      privateKeyPem: await privateKeyPem(),
      client,
    });
    await expect(issuer.issue(71, 1001, "write", "2026-10-17T00:00:00.000Z")).rejects.toThrow();
  });
});
