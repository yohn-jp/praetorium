import { isSha256Digest, type Sha256Digest } from "../artifacts/digest.js";
import type {
  ArtifactUseReference,
  CacheGcEntry,
  CacheGcPlan,
  CacheGcPolicy,
} from "./types.js";

function artifactDigests(entry: CacheGcEntry): readonly Sha256Digest[] {
  return [
    entry.artifact.image.digest,
    entry.artifact.image.platformManifestDigest,
    entry.artifact.compositionManifest.digest,
  ];
}

function bytes(entry: CacheGcEntry): number {
  const total = entry.artifact.reachableLayerBytes + entry.artifact.compositionManifestBytes;
  return Number.isSafeInteger(total) && total >= 0 ? total : Number.MAX_SAFE_INTEGER;
}

function evictionTime(entry: CacheGcEntry): number {
  const at = entry.lastHitAt ?? entry.admittedAt;
  const time = Date.parse(at);
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

/**
 * Plans bounded LRU eviction after minimum retention. Callers must obtain
 * references from current desired/running/rollback revisions in the same
 * transaction/lease that authorizes deletion; a stale snapshot is not an
 * authorization to remove an OCI manifest.
 */
export function planCacheGarbageCollection(
  entries: readonly CacheGcEntry[],
  references: readonly ArtifactUseReference[],
  policy: CacheGcPolicy,
): CacheGcPlan {
  if (!Number.isFinite(Date.parse(policy.now))) throw new TypeError("GC policy now is invalid");
  for (const [name, value] of Object.entries({ maxBytes: policy.maxBytes, maxEntries: policy.maxEntries, minAgeMs: policy.minAgeMs, maxEvictions: policy.maxEvictions })) {
    if (!Number.isSafeInteger(value) || value < 0 || (name === "maxEntries" && value === 0)) {
      throw new TypeError(`GC policy ${name} is invalid`);
    }
  }
  const referenced = new Set<Sha256Digest>();
  for (const reference of references) {
    if (!isSha256Digest(reference.digest)) throw new TypeError("live artifact reference must be an immutable sha256 digest");
    referenced.add(reference.digest);
  }

  let totalBytes = entries.reduce((total, entry) => Math.min(Number.MAX_SAFE_INTEGER, total + bytes(entry)), 0);
  let totalEntries = entries.length;
  const minAgeMs = policy.minAgeMs;
  const nowMs = Date.parse(policy.now);
  const eligible = [...entries]
    .filter((entry) => {
      const ageMs = nowMs - evictionTime(entry);
      return ageMs >= minAgeMs && !artifactDigests(entry).some((digest) => referenced.has(digest));
    })
    .sort((left, right) => evictionTime(left) - evictionTime(right));

  const selected: CacheGcEntry[] = [];
  for (const entry of eligible) {
    if (selected.length >= policy.maxEvictions) break;
    if (totalBytes <= policy.maxBytes && totalEntries <= policy.maxEntries) break;
    selected.push(entry);
    totalBytes = Math.max(0, totalBytes - bytes(entry));
    totalEntries -= 1;
  }

  const removedKeys = new Set(selected.map((entry) => entry.buildKey));
  const retained = entries.filter((entry) => !removedKeys.has(entry.buildKey));
  const retainedDigests = new Set(retained.flatMap((entry) => [...artifactDigests(entry)]));
  const deletableManifestDigests = new Set<Sha256Digest>();
  for (const entry of selected) {
    const manifestDigest = entry.artifact.image.digest;
    if (!referenced.has(manifestDigest) && !retainedDigests.has(manifestDigest)) {
      deletableManifestDigests.add(manifestDigest);
    }
  }

  return {
    evictedBuildKeys: selected.map((entry) => entry.buildKey),
    deletableManifestDigests: [...deletableManifestDigests],
    estimatedBytesAfter: totalBytes,
    entriesAfter: totalEntries,
  };
}
