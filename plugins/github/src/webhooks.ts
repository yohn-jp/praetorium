import { constantTimeEqual } from "@praetorium/auth";

export interface GitHubWebhookDeliveryStore {
  /** Atomically claims a delivery ID; false means this verified delivery was already processed. */
  claim(deliveryId: string, receivedAt: string): Promise<boolean>;
}

export interface VerifiedGitHubWebhook {
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string | null;
  readonly installationId: number | null;
  readonly repositoryIds: readonly number[];
}

export type GitHubWebhookResult =
  | { readonly status: "accepted"; readonly delivery: VerifiedGitHubWebhook }
  | { readonly status: "duplicate"; readonly deliveryId: string }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

export interface GitHubWebhookInput {
  readonly signature: string | null;
  readonly deliveryId: string | null;
  readonly event: string | null;
  readonly rawBody: Uint8Array;
  readonly receivedAt: string;
}

const encoder = new TextEncoder();

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numericId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function summarizeWebhook(
  deliveryId: string,
  event: string,
  value: unknown,
): VerifiedGitHubWebhook | null {
  if (!isObject(value)) return null;
  const installation = isObject(value.installation) ? value.installation : null;
  const repository = isObject(value.repository) ? value.repository : null;
  const repositoriesAdded = Array.isArray(value.repositories_added) ? value.repositories_added : [];
  const repositoriesRemoved = Array.isArray(value.repositories_removed)
    ? value.repositories_removed
    : [];
  const repositoryIds = new Set<number>();
  const repositoryId = repository ? numericId(repository.id) : null;
  if (repositoryId !== null) repositoryIds.add(repositoryId);
  for (const item of [...repositoriesAdded, ...repositoriesRemoved]) {
    const id = isObject(item) ? numericId(item.id) : null;
    if (id !== null) repositoryIds.add(id);
  }
  const installationId = installation ? numericId(installation.id) : null;
  return {
    deliveryId,
    event,
    action: typeof value.action === "string" ? value.action : null,
    installationId,
    repositoryIds: [...repositoryIds],
  };
}

/** Verifies GitHub's HMAC over the exact raw bytes before parsing or deduping a delivery. */
export async function verifyAndClaimGitHubWebhook(
  secret: string,
  store: GitHubWebhookDeliveryStore,
  input: GitHubWebhookInput,
): Promise<GitHubWebhookResult> {
  if (
    !secret ||
    !input.signature ||
    !/^sha256=[a-f0-9]{64}$/.test(input.signature) ||
    !input.deliveryId ||
    !/^[A-Za-z0-9-]{1,128}$/.test(input.deliveryId) ||
    !input.event ||
    !/^[a-z_]{1,64}$/.test(input.event)
  )
    return { status: "invalid" };

  let expected: string;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    expected = `sha256=${bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, bufferSource(input.rawBody))))}`;
  } catch {
    return { status: "unavailable" };
  }
  if (!constantTimeEqual(expected, input.signature)) return { status: "invalid" };

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(input.rawBody)) as unknown;
  } catch {
    return { status: "invalid" };
  }
  const delivery = summarizeWebhook(input.deliveryId, input.event, payload);
  if (!delivery) return { status: "invalid" };

  let claimed: boolean;
  try {
    claimed = await store.claim(input.deliveryId, input.receivedAt);
  } catch {
    return { status: "unavailable" };
  }
  return claimed
    ? { status: "accepted", delivery }
    : { status: "duplicate", deliveryId: input.deliveryId };
}
