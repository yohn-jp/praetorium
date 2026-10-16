import { verifyAndClaimGitHubWebhook } from "@praetorium/github";
import type { VerifiedGitHubWebhook } from "@praetorium/github";
import { Hono } from "hono";

const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
const MAX_REPOSITORIES_PER_DELIVERY = 100;

export interface GitHubWebhookDelivery {
  readonly deliveryId: string;
  readonly bodyDigest: string;
  readonly event: string;
  readonly action: string | null;
  readonly installationId: number | null;
  readonly repositoryIds: readonly number[];
  readonly repositorySelection?: "all" | "selected";
}

export type GitHubWebhookForwardResult = "accepted" | "duplicate" | "conflict";

export interface GitHubWebhookControlPlaneClient {
  receiveGitHubWebhook(delivery: GitHubWebhookDelivery): Promise<GitHubWebhookForwardResult>;
}

export interface GitHubWebhookRoutesDependencies {
  readonly webhookSecret: string;
  readonly controlPlane: GitHubWebhookControlPlaneClient;
  readonly now?: () => Date;
}

/** Builds the trusted Gateway-to-Control-Plane webhook client. */
export function createGitHubWebhookControlPlaneClient(
  binding: Pick<Fetcher, "fetch">,
  gatewaySecret: string,
): GitHubWebhookControlPlaneClient {
  if (gatewaySecret.length < 32)
    throw new TypeError("Control Plane Gateway authentication secret is required");
  return {
    async receiveGitHubWebhook(delivery) {
      const response = await binding.fetch(
        "https://control-plane.internal/internal/github/webhook",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Control-Plane-Gateway-Auth": gatewaySecret,
          },
          body: JSON.stringify(delivery),
        },
      );
      const result: unknown = await response.json().catch(() => null);
      if (response.status === 409) return "conflict";
      if (response.status === 202 && isRecord(result) && result.status === "accepted")
        return "accepted";
      if (response.status === 200 && isRecord(result) && result.status === "duplicate")
        return "duplicate";
      throw new Error("Control Plane webhook endpoint unavailable");
    },
  };
}

/** Public GitHub webhook endpoint; mount outside the Gateway session middleware. */
export function createGitHubWebhookRoutes(deps: GitHubWebhookRoutesDependencies) {
  if (deps.webhookSecret.length < 32) throw new TypeError("GitHub webhook secret is required");
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await readBoundedBody(c.req.raw);
    if (!body) return c.json({ error: "invalid_webhook_request" }, 400);

    const verified = await verifyAndClaimGitHubWebhook(
      deps.webhookSecret,
      { claim: async () => true },
      {
        signature: c.req.header("X-Hub-Signature-256") ?? null,
        deliveryId: c.req.header("X-GitHub-Delivery") ?? null,
        event: c.req.header("X-GitHub-Event") ?? null,
        rawBody: body,
        receivedAt: (deps.now ?? (() => new Date()))().toISOString(),
      },
    );
    if (verified.status === "invalid") return c.json({ error: "invalid_webhook_signature" }, 401);
    if (verified.status === "unavailable")
      return c.json({ error: "webhook_verification_unavailable" }, 503);
    if (verified.status !== "accepted")
      return c.json({ error: "webhook_verification_unavailable" }, 503);

    const delivery = await boundedDelivery(verified.delivery, body);
    if (!delivery) return c.json({ error: "invalid_webhook_payload" }, 400);

    try {
      const result = await deps.controlPlane.receiveGitHubWebhook(delivery);
      if (result === "conflict") return c.json({ error: "webhook_delivery_conflict" }, 409);
      return c.json({ status: result }, result === "accepted" ? 202 : 200);
    } catch {
      return c.json({ error: "webhook_processing_unavailable" }, 503, { "Retry-After": "5" });
    }
  });

  return app;
}

async function boundedDelivery(
  verified: VerifiedGitHubWebhook,
  body: Uint8Array,
): Promise<GitHubWebhookDelivery | null> {
  if (
    (verified.action !== null && !/^[a-z_]{1,64}$/.test(verified.action)) ||
    verified.repositoryIds.length > MAX_REPOSITORIES_PER_DELIVERY
  )
    return null;

  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
    ) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;

  let repositorySelection: "all" | "selected" | undefined;
  if (verified.event === "installation_repositories") {
    const selection = payload.repository_selection;
    if (selection !== undefined) {
      if (selection !== "all" && selection !== "selected") return null;
      repositorySelection = selection;
    }
  }

  let repositoryIds = [...verified.repositoryIds];
  if (verified.event === "installation") {
    repositoryIds = [];
    if (
      (verified.action === "deleted" || verified.action === "suspend") &&
      verified.installationId === null
    )
      return null;
  } else if (verified.event === "installation_repositories" && verified.action === "removed") {
    const removed = payload.repositories_removed;
    if (!Array.isArray(removed) || removed.length > MAX_REPOSITORIES_PER_DELIVERY) return null;
    const ids: number[] = [];
    for (const item of removed) {
      if (!isRecord(item) || !positiveSafeId(item.id)) return null;
      ids.push(item.id);
    }
    repositoryIds = [...new Set(ids)];
    if (verified.installationId === null) return null;
  } else if (verified.event === "repository") {
    const repository = isRecord(payload.repository) ? payload.repository : null;
    if (!repository || !positiveSafeId(repository.id)) {
      if (verified.action === "renamed" || verified.action === "transferred") return null;
      repositoryIds = [];
    } else {
      repositoryIds = [repository.id];
    }
    if (
      (verified.action === "renamed" || verified.action === "transferred") &&
      verified.installationId === null
    )
      return null;
  }
  if (repositoryIds.some((id) => !positiveSafeId(id))) return null;
  if (repositoryIds.length > MAX_REPOSITORIES_PER_DELIVERY) return null;

  const bodyDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    deliveryId: verified.deliveryId,
    bodyDigest,
    event: verified.event,
    action: verified.action,
    installationId: verified.installationId,
    repositoryIds,
    ...(repositorySelection === undefined ? {} : { repositorySelection }),
  };
}

function positiveSafeId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  const rawLength = request.headers.get("Content-Length");
  if (
    rawLength !== null &&
    (!/^(0|[1-9][0-9]*)$/.test(rawLength) || Number(rawLength) > MAX_WEBHOOK_BODY_BYTES)
  )
    return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WEBHOOK_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
