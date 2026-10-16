import { describe, expect, it } from "vitest";
import { createGitHubInstallationTokenIssuer } from "../src/installation-token.js";
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
