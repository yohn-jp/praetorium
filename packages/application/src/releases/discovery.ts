import type { ReleasePromotionRepository } from "./model.js";

export const RELEASE_DISCOVERY_INTERVAL_MS = 5 * 60 * 1_000;
export const RELEASE_DISCOVERY_PAGE_SIZE = 50;

export type DiscoveryResult =
  | { readonly kind: "advanced"; readonly discovered: number; readonly nextCursor: string | null }
  | { readonly kind: "conflict"; readonly discovered: 0; readonly nextCursor: string | null };

/**
 * Reconciles candidates that predate workflow-on-admission in bounded pages.
 * The checkpoint moves forward and stays at the last seen candidate after the
 * current catalog is exhausted, so later runs only inspect the new tail.
 */
export async function discoverStableCandidates(
  releases: ReleasePromotionRepository,
  input: { readonly at: string; readonly limit?: number },
): Promise<DiscoveryResult> {
  const checkpoint = await releases.getDiscoveryCheckpoint();
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? RELEASE_DISCOVERY_PAGE_SIZE)));
  const page = await releases.listCandidates(checkpoint.cursor, limit);
  if (page.items.length === 0 && page.nextCursor === null) {
    return { kind: "advanced", discovered: 0, nextCursor: null };
  }
  const result = await releases.commitDiscoveryPage({
    expectedRevision: checkpoint.revision,
    expectedCursor: checkpoint.cursor,
    page,
    at: input.at,
  });
  if (result === "conflict") {
    const current = await releases.getDiscoveryCheckpoint();
    return { kind: "conflict", discovered: 0, nextCursor: current.cursor };
  }
  return { kind: "advanced", discovered: page.items.length, nextCursor: page.nextCursor };
}
