import type { Sha256Digest } from "../artifacts/digest.js";
import type { VerifiedArtifact } from "../artifacts/types.js";

export interface AdmittedBuildArtifactRecord {
  readonly state: "admitted";
  readonly buildKey: Sha256Digest;
  readonly artifact: VerifiedArtifact;
  /** Append-only equivalent attestations allow key rotation without replacing artifact identity. */
  readonly attestations: readonly VerifiedArtifact[];
  readonly admittedAt: string;
  readonly lastHitAt: string | null;
}

export interface ConflictedBuildArtifactRecord {
  readonly state: "conflict";
  readonly buildKey: Sha256Digest;
  readonly artifacts: readonly VerifiedArtifact[];
  readonly conflictAt: string;
}

export type BuildArtifactCacheRecord = AdmittedBuildArtifactRecord | ConflictedBuildArtifactRecord;

/**
 * Implementations must perform recordVerifiedArtifact atomically by build key:
 * absent -> admitted; identical output -> append evidence; divergent output ->
 * conflict. A conflict is permanent in this interface and cannot be cleared by
 * a later worker report.
 */
export interface BuildArtifactCacheStore {
  findByBuildKey(buildKey: Sha256Digest): Promise<BuildArtifactCacheRecord | null>;
  recordVerifiedArtifact(artifact: VerifiedArtifact): Promise<BuildArtifactCacheRecord>;
  recordCacheHit(buildKey: Sha256Digest, hitAt: string): Promise<void>;
  listAdmittedArtifacts(): Promise<readonly AdmittedBuildArtifactRecord[]>;
}

export type BuildCacheMissReason =
  | "not_found"
  | "conflicted"
  | "artifact_unreachable"
  | "admission_policy_failed";

export type BuildCacheLookup =
  | { readonly hit: true; readonly artifact: VerifiedArtifact }
  | { readonly hit: false; readonly reason: BuildCacheMissReason };

export interface ArtifactUseReference {
  readonly digest: Sha256Digest;
  readonly reason: "running" | "desired" | "rollback";
}

export interface CacheGcEntry {
  readonly buildKey: Sha256Digest;
  readonly artifact: VerifiedArtifact;
  readonly admittedAt: string;
  readonly lastHitAt: string | null;
}

export interface CacheGcPolicy {
  readonly now: string;
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly minAgeMs: number;
  readonly maxEvictions: number;
}

export interface CacheGcPlan {
  readonly evictedBuildKeys: readonly Sha256Digest[];
  /** Manifests can be deleted only when no retained cache entry or live revision references them. */
  readonly deletableManifestDigests: readonly Sha256Digest[];
  readonly estimatedBytesAfter: number;
  readonly entriesAfter: number;
}
