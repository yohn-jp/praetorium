import {
  planCacheGarbageCollection,
  type ArtifactUseReference,
} from "@praetorium/application/build-cache";
import type { Sha256Digest } from "@praetorium/application/artifacts";
import {
  D1ArtifactCacheStore,
  type D1ArtifactCacheGarbageCollectionSnapshot,
  type D1Database,
} from "@praetorium/persistence/d1";

const MAX_EVICTIONS_PER_RUN = 32;
const MAX_AUDIT_METADATA_BYTES = 8_192;
const SYSTEM_ACTOR_ID = "system:build-cache-maintenance";
const GC_AUDIT_ACTION = "build-cache.gc.planned";

export interface CacheRetentionPolicy {
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly minAgeMs: number;
  readonly maxEvictions: number;
}

export interface CacheMaintenanceSnapshotReader {
  getGarbageCollectionSnapshot(): Promise<D1ArtifactCacheGarbageCollectionSnapshot>;
}

export interface CacheMaintenanceResult {
  readonly action: typeof GC_AUDIT_ACTION;
  readonly auditEventId: string;
  readonly now: string;
  readonly budgetScope: "admitted-cache-snapshot";
  /** A snapshot-derived proposal does not authorize an OCI/cache deletion. */
  readonly advisoryOnly: true;
  readonly deletionAuthorized: false;
  readonly deletionAttempted: false;
  /** Estimate is limited to admitted, non-conflicted entries in the D1 snapshot. */
  readonly overBudget: boolean;
  /** Hypothetical estimate if the candidates were removed; no removal was attempted. */
  readonly overBudgetAfterPlan: boolean;
  readonly policy: CacheRetentionPolicy;
  readonly entriesBefore: number;
  readonly estimatedBytesBefore: number;
  readonly entriesAfterPlan: number;
  readonly estimatedBytesAfterPlan: number;
  readonly references: readonly ArtifactUseReference[];
  readonly referenceCounts: Readonly<Record<ArtifactUseReference["reason"], number>>;
  readonly candidateBuildKeys: readonly Sha256Digest[];
  /** Candidate digests from the planner snapshot; never a delete authorization. */
  readonly candidateManifestDigests: readonly Sha256Digest[];
}

export interface PlanCacheMaintenanceInput {
  readonly db: D1Database;
  readonly cacheStore: CacheMaintenanceSnapshotReader;
  readonly policy: CacheRetentionPolicy;
  readonly now: Date;
}

/**
 * Creates a bounded, audited maintenance plan from the D1 cache/reference
 * snapshot. It does not delete D1 rows or registry manifests: the snapshot is
 * advisory and must not be reused as authorization for a later destructive op.
 */
export async function planCacheMaintenance(
  input: PlanCacheMaintenanceInput,
): Promise<CacheMaintenanceResult> {
  const policy = validatePolicy(input.policy);
  const nowMs = input.now.getTime();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("cache maintenance time must be a valid non-negative Date");
  }
  const now = input.now.toISOString();

  const snapshot = await input.cacheStore.getGarbageCollectionSnapshot();
  const referenceCounts = countReferences(snapshot.references);
  const plan = planCacheGarbageCollection(snapshot.entries, snapshot.references, {
    ...policy,
    now,
  });
  const estimatedBytesBefore = estimateBytes(snapshot.entries);
  const overBudget =
    estimatedBytesBefore > policy.maxBytes || snapshot.entries.length > policy.maxEntries;
  const overBudgetAfterPlan =
    plan.estimatedBytesAfter > policy.maxBytes || plan.entriesAfter > policy.maxEntries;
  const candidateBuildKeys = [...plan.evictedBuildKeys];
  const candidateManifestDigests = [...plan.deletableManifestDigests];

  if (
    candidateBuildKeys.length > MAX_EVICTIONS_PER_RUN ||
    candidateManifestDigests.length > MAX_EVICTIONS_PER_RUN
  ) {
    throw new Error("cache planner exceeded the bounded per-run candidate limit");
  }

  const auditEventId = `aud_cache_gc_${crypto.randomUUID()}`;
  const requestId = `cache-maintenance:${auditEventId}`;
  const metadata = {
    schemaVersion: 1,
    budgetScope: "admitted-cache-snapshot",
    advisoryOnly: true,
    deletionAuthorized: false,
    deletionAttempted: false,
    overBudget,
    overBudgetAfterPlan,
    entriesBefore: snapshot.entries.length,
    estimatedBytesBefore,
    entriesAfterPlan: plan.entriesAfter,
    estimatedBytesAfterPlan: plan.estimatedBytesAfter,
    references: referenceCounts,
    candidateBuildKeyCount: candidateBuildKeys.length,
    candidateBuildKeys,
    candidateManifestDigestCount: candidateManifestDigests.length,
    candidateManifestDigests,
    policy,
  };
  const metadataJson = JSON.stringify(metadata);
  if (new TextEncoder().encode(metadataJson).byteLength > MAX_AUDIT_METADATA_BYTES) {
    throw new RangeError("cache maintenance audit metadata exceeded its bounded size");
  }

  const audit = await input.db
    .prepare(
      `INSERT INTO audit_events (
         event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
         action, outcome, request_id, metadata_json, occurred_at
       ) VALUES (?, NULL, NULL, NULL, ?, 'system', ?, 'planned', ?, ?, ?)`,
    )
    .bind(auditEventId, SYSTEM_ACTOR_ID, GC_AUDIT_ACTION, requestId, metadataJson, nowMs)
    .run();
  if (audit.meta.changes !== 1) {
    throw new Error("cache maintenance advisory plan was not durably audited");
  }

  return {
    action: GC_AUDIT_ACTION,
    auditEventId,
    now,
    budgetScope: "admitted-cache-snapshot",
    advisoryOnly: true,
    deletionAuthorized: false,
    deletionAttempted: false,
    overBudget,
    overBudgetAfterPlan,
    policy,
    entriesBefore: snapshot.entries.length,
    estimatedBytesBefore,
    entriesAfterPlan: plan.entriesAfter,
    estimatedBytesAfterPlan: plan.estimatedBytesAfter,
    references: snapshot.references,
    referenceCounts,
    candidateBuildKeys,
    candidateManifestDigests,
  };
}

/** The production cache store is the intended snapshot reader. */
export function createD1CacheMaintenanceSnapshotReader(
  db: D1Database,
): CacheMaintenanceSnapshotReader {
  return new D1ArtifactCacheStore(db);
}

function validatePolicy(value: CacheRetentionPolicy): CacheRetentionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("cache retention policy must be an object");
  }
  const expectedKeys = new Set(["maxBytes", "maxEntries", "minAgeMs", "maxEvictions"]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) {
    throw new TypeError("cache retention policy has missing or unknown fields");
  }

  const bounds: Readonly<Record<keyof CacheRetentionPolicy, readonly [number, number]>> = {
    maxBytes: [0, Number.MAX_SAFE_INTEGER],
    maxEntries: [1, Number.MAX_SAFE_INTEGER],
    minAgeMs: [0, Number.MAX_SAFE_INTEGER],
    maxEvictions: [1, MAX_EVICTIONS_PER_RUN],
  };
  for (const [key, [minimum, maximum]] of Object.entries(bounds) as [
    keyof CacheRetentionPolicy,
    readonly [number, number],
  ][]) {
    const valueForKey = value[key];
    if (!Number.isSafeInteger(valueForKey) || valueForKey < minimum || valueForKey > maximum) {
      throw new TypeError(`cache retention policy ${key} is outside its allowed bounds`);
    }
  }
  return Object.freeze({ ...value });
}

function estimateBytes(snapshot: D1ArtifactCacheGarbageCollectionSnapshot["entries"]): number {
  return snapshot.reduce((total, entry) => {
    const bytes = entry.artifact.reachableLayerBytes + entry.artifact.compositionManifestBytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0) return Number.MAX_SAFE_INTEGER;
    return Math.min(Number.MAX_SAFE_INTEGER, total + bytes);
  }, 0);
}

function countReferences(
  references: readonly ArtifactUseReference[],
): Readonly<Record<ArtifactUseReference["reason"], number>> {
  const counts = { running: 0, desired: 0, rollback: 0 };
  for (const reference of references) counts[reference.reason] += 1;
  return Object.freeze(counts);
}
