import { describe, expect, it, vi } from "vitest";
import {
  createGitHubWebhookControlPlaneClient,
  createGitHubWebhookRoutes,
  type GitHubWebhookDelivery,
} from "./github-webhook.js";

const SECRET = "a-webhook-secret-with-enough-entropy-for-testing";
const GATEWAY_SECRET = "a-gateway-service-secret-with-enough-entropy";

describe("Gateway GitHub webhook boundary", () => {
  it("forwards only verified bounded metadata and hashes the exact raw body", async () => {
    const rawBody = new TextEncoder().encode(
      JSON.stringify({
        action: "removed",
        repository_selection: "selected",
        installation: { id: 71 },
        repositories_added: [{ id: 1001 }],
        repositories_removed: [{ id: 1002 }, { id: 1003 }],
      }),
    );
    let forwardedDelivery: GitHubWebhookDelivery | undefined;
    const receiveGitHubWebhook = vi.fn(async (delivery: GitHubWebhookDelivery) => {
      forwardedDelivery = delivery;
      return "accepted" as const;
    });
    const app = createGitHubWebhookRoutes({
      webhookSecret: SECRET,
      controlPlane: { receiveGitHubWebhook },
      now: () => new Date("2026-10-17T00:00:00.000Z"),
    });
    const response = await app.request("/", {
      method: "POST",
      headers: await githubHeaders(rawBody, "installation_repositories", "delivery-1"),
      body: rawBody,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(receiveGitHubWebhook).toHaveBeenCalledTimes(1);
    expect(forwardedDelivery).toEqual({
      deliveryId: "delivery-1",
      bodyDigest: await sha256(rawBody),
      event: "installation_repositories",
      action: "removed",
      installationId: 71,
      repositoryIds: [1002, 1003],
      repositorySelection: "selected",
    });
    expect(JSON.stringify(forwardedDelivery)).not.toContain("repositories_removed");
    expect(JSON.stringify(forwardedDelivery)).not.toContain("repositories_added");
  });

  it("does not call the Control Plane when the signature is invalid", async () => {
    const rawBody = new TextEncoder().encode(
      JSON.stringify({ action: "deleted", installation: { id: 71 } }),
    );
    const received: GitHubWebhookDelivery[] = [];
    const receiveGitHubWebhook = vi.fn(async (delivery: GitHubWebhookDelivery) => {
      received.push(delivery);
      return "accepted" as const;
    });
    const app = createGitHubWebhookRoutes({
      webhookSecret: SECRET,
      controlPlane: { receiveGitHubWebhook },
    });
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
        "X-GitHub-Delivery": "delivery-2",
        "X-GitHub-Event": "installation",
      },
      body: rawBody,
    });

    expect(response.status).toBe(401);
    expect(receiveGitHubWebhook).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it("rejects an invalid installation repository selection before forwarding", async () => {
    const rawBody = new TextEncoder().encode(
      JSON.stringify({
        action: "removed",
        repository_selection: "unexpected",
        installation: { id: 71 },
        repositories_removed: [],
      }),
    );
    const receiveGitHubWebhook = vi.fn(async () => "accepted" as const);
    const app = createGitHubWebhookRoutes({
      webhookSecret: SECRET,
      controlPlane: { receiveGitHubWebhook },
    });
    const response = await app.request("/", {
      method: "POST",
      headers: await githubHeaders(
        rawBody,
        "installation_repositories",
        "delivery-invalid-selection",
      ),
      body: rawBody,
    });

    expect(response.status).toBe(400);
    expect(receiveGitHubWebhook).not.toHaveBeenCalled();
  });

  it("rejects an installation repository event missing its required selection before forwarding", async () => {
    const rawBody = new TextEncoder().encode(
      JSON.stringify({
        action: "removed",
        installation: { id: 71 },
        repositories_removed: [],
      }),
    );
    const receiveGitHubWebhook = vi.fn(async () => "accepted" as const);
    const app = createGitHubWebhookRoutes({
      webhookSecret: SECRET,
      controlPlane: { receiveGitHubWebhook },
    });
    const response = await app.request("/", {
      method: "POST",
      headers: await githubHeaders(
        rawBody,
        "installation_repositories",
        "delivery-missing-selection",
      ),
      body: rawBody,
    });

    expect(response.status).toBe(400);
    expect(receiveGitHubWebhook).not.toHaveBeenCalled();
  });

  it("authenticates the private Control Plane call with the configured service secret", async () => {
    const forwardedRequests: Request[] = [];
    const client = createGitHubWebhookControlPlaneClient(
      {
        async fetch(input, init) {
          forwardedRequests.push(new Request(input, init));
          return Response.json({ status: "accepted" }, { status: 202 });
        },
      },
      GATEWAY_SECRET,
    );
    const delivery: GitHubWebhookDelivery = {
      deliveryId: "delivery-3",
      bodyDigest: "a".repeat(64),
      event: "issues",
      action: "opened",
      installationId: 71,
      repositoryIds: [1001],
    };

    await expect(client.receiveGitHubWebhook(delivery)).resolves.toBe("accepted");
    expect(forwardedRequests[0]?.url).toBe(
      "https://control-plane.internal/internal/github/webhook",
    );
    expect(forwardedRequests[0]?.headers.get("X-Control-Plane-Gateway-Auth")).toBe(GATEWAY_SECRET);
    expect(await forwardedRequests[0]?.json()).toEqual(delivery);
  });
});

async function githubHeaders(
  rawBody: Uint8Array,
  event: string,
  deliveryId: string,
): Promise<Headers> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  const hex = [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Headers({
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${hex}`,
    "X-GitHub-Delivery": deliveryId,
    "X-GitHub-Event": event,
  });
}

async function sha256(value: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
