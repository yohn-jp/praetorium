import {
  BuildInputSchema,
  BuilderArtifactStatementSchema,
  BuilderSignatureSchema,
  buildKey as computeBuildKey,
  canonicalBuildInput,
  type BuilderArtifactStatement,
  type BuilderSignature,
} from "@praetorium/contracts";
import type {
  AdmittedBuildArtifactRecord,
  ArtifactUseReference,
  BuildArtifactCacheRecord,
  BuildArtifactCacheStore,
  CacheGcEntry,
} from "@praetorium/application/build-cache";
import { recordVerifiedArtifactTransition } from "@praetorium/application/build-cache";
import {
  isSha256Digest,
  type Sha256Digest,
  type VerifiedArtifact,
} from "@praetorium/application/artifacts";
import type { D1Database, D1PreparedStatement } from "./types.js";

interface BuildRow {
  readonly build_id: string;
  readonly build_key: string;
  readonly build_input_json: string;
  readonly status: string;
  readonly active_attempt_id: string | null;
  readonly artifact_digest: string | null;
  readonly failure_json: string | null;
  readonly updated_at: number;
}

interface ArtifactRow {
  readonly artifact_digest: string;
  readonly build_key: string;
  readonly manifest_digest: string;
  readonly platform_manifest_digest: string;
  readonly composition_manifest_digest: string;
  readonly producer_revision: string;
  readonly resolved_modules_json: string;
  readonly verification_json: string;
  readonly statement_json: string;
  readonly signature_json: string;
  readonly status: "admitted" | "rejected";
  readonly created_at: number;
  readonly admitted_at: number | null;
}

interface CacheEvidence {
  readonly statement: BuilderArtifactStatement;
  readonly signature: BuilderSignature;
  readonly verifiedAt: string;
  readonly signerKeyId: string;
  readonly reachableLayerBytes: number;
  readonly compositionManifestBytes: number;
}

interface VerificationJson extends Record<string, unknown> {
  readonly schemaVersion: 1;
  readonly verifiedAt: string;
  readonly signerKeyId: string;
  readonly reachableLayerBytes: number;
  readonly compositionManifestBytes: number;
  readonly cache?: {
    readonly lastHitAt?: string | null;
    readonly attestations?: readonly CacheEvidence[];
    readonly conflicts?: readonly CacheEvidence[];
    readonly conflictAt?: string;
  };
}

interface SnapshotRow extends ArtifactRow {
  readonly row_kind: "artifact" | "reference";
  readonly build_input_json: string;
  readonly reference_digest: string | null;
  readonly reference_reason: ArtifactUseReference["reason"] | null;
}

export interface D1ArtifactCacheGarbageCollectionSnapshot {
  readonly entries: readonly (CacheGcEntry & {
    readonly attestations: readonly VerifiedArtifact[];
  })[];
  readonly references: readonly ArtifactUseReference[];
}

const MAX_CACHE_VERIFICATION_BYTES = 512 * 1024;
const MAX_CAS_ATTEMPTS = 4;

/**
 * Reads and enriches artifact rows admitted by D1BuildStore. A missing row can
 * only be restored from a successful fenced build and attempt that already
 * name the same immutable artifact digest.
 */
export class D1ArtifactCacheStore implements BuildArtifactCacheStore {
  constructor(
    private readonly db: D1Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async findByBuildKey(buildKey: Sha256Digest): Promise<BuildArtifactCacheRecord | null> {
    validateBuildKey(buildKey);
    const stored = await this.readStoredBuild(buildKey);
    return stored?.record ?? null;
  }

  async recordVerifiedArtifact(artifact: VerifiedArtifact): Promise<BuildArtifactCacheRecord> {
    await validateVerifiedArtifact(artifact);
    const at = safeIsoTime(this.clock);

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const stored = await this.readStoredBuild(artifact.buildKey);
      if (!stored) {
        throw new Error(
          "D1BuildStore must persist a successful artifact report before cache admission",
        );
      }
      if (stored.record?.state === "conflict") return stored.record;
      if (!stored.artifactRow) {
        if (
          !stored.build ||
          stored.build.status !== "succeeded" ||
          stored.build.artifact_digest !== artifact.image.digest ||
          stored.build.active_attempt_id === null ||
          isArtifactConflict(stored.build)
        ) {
          throw new Error(
            "cache admission requires a successful D1 build report for this artifact",
          );
        }
        const persistedInput = await parseBuildInput(
          stored.build.build_input_json,
          stored.build.build_key,
        );
        if (canonicalBuildInput(persistedInput) !== canonicalBuildInput(artifact.buildInput)) {
          throw new Error("cache artifact input does not match the successful D1 build");
        }
        try {
          await this.db.batch([
            this.insertMissingArtifact(stored.build, artifact, Date.parse(at)),
            this.assertOneChange(),
          ]);
        } catch (error) {
          if (!isTransactionAssertion(error)) throw error;
          const concurrent = await this.readStoredBuild(artifact.buildKey);
          if (concurrent?.record?.state === "conflict") return concurrent.record;
          if (!concurrent?.artifactRow) {
            throw new Error("successful D1 build attempt cannot safely persist this artifact");
          }
        }
        continue;
      }
      if (!stored.record || !stored.verification) {
        throw new Error("successful D1 build has no cacheable admitted artifact row");
      }

      const next = recordVerifiedArtifactTransition(stored.record, artifact, at);
      const verification = updateCacheMetadata(stored.verification, stored.record, next);
      const encoded = JSON.stringify(verification);
      if (new TextEncoder().encode(encoded).byteLength > MAX_CACHE_VERIFICATION_BYTES) {
        throw new RangeError(
          "artifact cache verification history exceeds its bounded D1 representation",
        );
      }
      if (encoded === stored.artifactRow.verification_json) return next;

      try {
        await this.db.batch([
          this.db
            .prepare(
              `UPDATE artifacts SET verification_json = ?
               WHERE artifact_digest = ? AND build_key = ? AND status = 'admitted'
                 AND verification_json = ?
                 AND EXISTS (
                   SELECT 1 FROM builds b WHERE b.build_key = artifacts.build_key
                     AND b.status = 'succeeded' AND b.artifact_digest = artifacts.artifact_digest
                     AND COALESCE(json_extract(b.failure_json, '$.code'), '') <> 'ARTIFACT_CONFLICT'
                 )`,
            )
            .bind(
              encoded,
              stored.artifactRow.artifact_digest,
              artifact.buildKey,
              stored.artifactRow.verification_json,
            ),
          this.assertOneChange(),
        ]);
        return next;
      } catch (error) {
        if (!isTransactionAssertion(error)) throw error;
      }
    }

    const latest = await this.readStoredBuild(artifact.buildKey);
    if (latest?.record?.state === "conflict") return latest.record;
    throw new Error("artifact cache record changed repeatedly during its D1 compare-and-set");
  }

  async recordCacheHit(buildKey: Sha256Digest, hitAt: string): Promise<void> {
    validateBuildKey(buildKey);
    const hitTime = canonicalIsoTime(hitAt, "cache hit time");

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const stored = await this.readStoredBuild(buildKey);
      if (
        !stored?.record ||
        stored.record.state === "conflict" ||
        !stored.artifactRow ||
        !stored.verification
      ) {
        throw new Error("cannot record a cache hit without a current admitted cache entry");
      }
      const existingHit = stored.verification.cache?.lastHitAt ?? null;
      const nextHit =
        existingHit !== null && Date.parse(existingHit) > Date.parse(hitTime)
          ? existingHit
          : hitTime;
      if (existingHit === nextHit) return;
      const encoded = JSON.stringify({
        ...stored.verification,
        cache: { ...stored.verification.cache, lastHitAt: nextHit },
      });
      try {
        await this.db.batch([
          this.db
            .prepare(
              `UPDATE artifacts SET verification_json = ?
               WHERE artifact_digest = ? AND build_key = ? AND status = 'admitted'
                 AND verification_json = ?
                 AND EXISTS (
                   SELECT 1 FROM builds b WHERE b.build_key = artifacts.build_key
                     AND b.status = 'succeeded' AND b.artifact_digest = artifacts.artifact_digest
                     AND COALESCE(json_extract(b.failure_json, '$.code'), '') <> 'ARTIFACT_CONFLICT'
                 )
                 AND COALESCE(json_array_length(json_extract(verification_json, '$.cache.conflicts')), 0) = 0`,
            )
            .bind(
              encoded,
              stored.artifactRow.artifact_digest,
              buildKey,
              stored.artifactRow.verification_json,
            ),
          this.assertOneChange(),
        ]);
        return;
      } catch (error) {
        if (!isTransactionAssertion(error)) throw error;
      }
    }
    throw new Error("cache entry changed repeatedly while recording a D1 cache hit");
  }

  async listAdmittedArtifacts(): Promise<readonly AdmittedBuildArtifactRecord[]> {
    const snapshot = await this.getGarbageCollectionSnapshot();
    return snapshot.entries.map(({ buildKey, artifact, admittedAt, lastHitAt, attestations }) => ({
      state: "admitted",
      buildKey,
      artifact,
      attestations,
      admittedAt,
      lastHitAt,
    }));
  }

  /**
   * Reads cache entries and live references in one SQL statement. The returned
   * plan inputs are a read snapshot, not a lease authorizing registry deletion.
   */
  async getGarbageCollectionSnapshot(): Promise<D1ArtifactCacheGarbageCollectionSnapshot> {
    const rows = await this.db.prepare(GC_SNAPSHOT_SQL).all<SnapshotRow>();
    const entries: (CacheGcEntry & { readonly attestations: readonly VerifiedArtifact[] })[] = [];
    const references = new Map<string, ArtifactUseReference>();

    for (const row of rows.results) {
      if (row.row_kind === "reference") {
        if (
          row.reference_digest === null ||
          row.reference_reason === null ||
          !isSha256Digest(row.reference_digest)
        ) {
          throw new TypeError("D1 returned an invalid live artifact reference");
        }
        const reference = { digest: row.reference_digest, reason: row.reference_reason } as const;
        references.set(`${reference.digest}\u0000${reference.reason}`, reference);
        continue;
      }

      const stored = await this.readArtifactRow(
        row,
        {
          build_key: row.build_key,
          build_input_json: row.build_input_json,
        },
        true,
      );
      if (!stored) continue;
      const admittedAt = timestampIso(row.admitted_at ?? row.created_at, "artifact admitted_at");
      entries.push({
        buildKey: row.build_key as Sha256Digest,
        artifact: stored.artifact,
        admittedAt,
        lastHitAt: stored.verification.cache?.lastHitAt ?? null,
        attestations: stored.attestations,
      });
    }

    return { entries, references: [...references.values()] };
  }

  async listArtifactUseReferences(): Promise<readonly ArtifactUseReference[]> {
    return (await this.getGarbageCollectionSnapshot()).references;
  }

  private async readStoredBuild(buildKey: Sha256Digest): Promise<{
    readonly record: BuildArtifactCacheRecord | null;
    readonly artifactRow: ArtifactRow | null;
    readonly verification: VerificationJson | null;
    readonly build: BuildRow;
  } | null> {
    const build = await this.db
      .prepare(
        `SELECT build_id, build_key, build_input_json, status, active_attempt_id,
                artifact_digest, failure_json, updated_at
         FROM builds WHERE build_key = ?`,
      )
      .bind(buildKey)
      .first<BuildRow>();
    if (!build) return null;

    const artifactRow = await this.db
      .prepare(
        `SELECT artifact_digest, build_key, manifest_digest, platform_manifest_digest,
                composition_manifest_digest, producer_revision, resolved_modules_json,
                verification_json, statement_json, signature_json, status, created_at, admitted_at
         FROM artifacts WHERE build_key = ? AND status = 'admitted'`,
      )
      .bind(buildKey)
      .first<ArtifactRow>();

    if (!artifactRow) {
      const conflict = isArtifactConflict(build);
      return {
        record: conflict ? conflictRecord(buildKey, null, build.updated_at) : null,
        artifactRow: null,
        verification: null,
        build,
      };
    }

    const stored = await this.readArtifactRow(artifactRow, build, true);
    if (!stored) throw new Error("admitted artifact row did not produce a verified cache record");
    const conflict =
      isArtifactConflict(build) || (stored.verification.cache?.conflicts?.length ?? 0) > 0;
    const healthyAdmission =
      build.status === "succeeded" && build.artifact_digest === artifactRow.artifact_digest;
    const record: BuildArtifactCacheRecord | null = conflict
      ? conflictRecord(
          buildKey,
          [stored.artifact, ...stored.conflictArtifacts],
          stored.verification.cache?.conflictAt ??
            timestampIso(build.updated_at, "build updated_at"),
        )
      : !healthyAdmission
        ? null
        : {
            state: "admitted",
            buildKey,
            artifact: stored.artifact,
            attestations: stored.attestations,
            admittedAt: timestampIso(
              artifactRow.admitted_at ?? artifactRow.created_at,
              "artifact admitted_at",
            ),
            lastHitAt: stored.verification.cache?.lastHitAt ?? null,
          };
    return { record, artifactRow, verification: stored.verification, build };
  }

  private async readArtifactRow(
    row: ArtifactRow,
    build: Pick<BuildRow, "build_key" | "build_input_json">,
    includeCacheHistory: boolean,
  ): Promise<{
    readonly artifact: VerifiedArtifact;
    readonly attestations: readonly VerifiedArtifact[];
    readonly conflictArtifacts: readonly VerifiedArtifact[];
    readonly verification: VerificationJson;
  } | null> {
    const input = await parseBuildInput(build.build_input_json, build.build_key);
    const verification = parseVerificationJson(row.verification_json);
    const base = artifactFromEvidence(
      {
        statement: parseJson(row.statement_json, "artifact statement") as BuilderArtifactStatement,
        signature: parseJson(row.signature_json, "artifact signature") as BuilderSignature,
        verifiedAt: verification.verifiedAt,
        signerKeyId: verification.signerKeyId,
        reachableLayerBytes: verification.reachableLayerBytes,
        compositionManifestBytes: verification.compositionManifestBytes,
      },
      input,
      row,
      true,
    );
    if (!base) return null;

    const attestations = [base];
    const conflicts: VerifiedArtifact[] = [];
    if (includeCacheHistory) {
      for (const evidence of verification.cache?.attestations ?? []) {
        const parsed = artifactFromEvidence(evidence, input, row, true);
        if (
          parsed &&
          !attestations.some((item) => admissionIdentity(item) === admissionIdentity(parsed))
        ) {
          attestations.push(parsed);
        }
      }
      for (const evidence of verification.cache?.conflicts ?? []) {
        const parsed = artifactFromEvidence(evidence, input, row, false);
        if (parsed && !conflicts.some((item) => outputIdentity(item) === outputIdentity(parsed))) {
          conflicts.push(parsed);
        }
      }
    }
    return { artifact: base, attestations, conflictArtifacts: conflicts, verification };
  }

  private assertOneChange(): D1PreparedStatement {
    return this.db.prepare(
      "INSERT INTO platform_transaction_sentinel(id) SELECT 1 WHERE changes() <> 1",
    );
  }

  private insertMissingArtifact(
    build: BuildRow,
    artifact: VerifiedArtifact,
    now: number,
  ): D1PreparedStatement {
    const evidence = toEvidence(artifact);
    const verification = {
      schemaVersion: artifact.schemaVersion,
      verifiedAt: artifact.verifiedAt,
      signerKeyId: artifact.signerKeyId,
      reachableLayerBytes: artifact.reachableLayerBytes,
      compositionManifestBytes: artifact.compositionManifestBytes,
    };
    const contractVersions = {
      build: artifact.contractVersion,
      composition: "scriptorium-composition/v1",
    };
    if (!Number.isSafeInteger(now) || now < 0)
      throw new TypeError("cache admission time is invalid");
    return this.db
      .prepare(
        `INSERT INTO artifacts (
           artifact_digest, build_key, build_id, attempt_id, manifest_digest,
           platform_manifest_digest, composition_manifest_digest, producer_revision,
           requested_modules_json, resolved_modules_json, contract_versions_json,
           sbom_ref, provenance_ref, verification_json, statement_json, signature_json,
           verifier_id, status, created_at, admitted_at
         ) SELECT ?, b.build_key, b.build_id, attempt.attempt_id, ?, ?, ?, ?, ?, ?, ?,
                  NULL, NULL, ?, ?, ?, 'control-plane-artifact-admission', 'admitted', ?, ?
           FROM builds b JOIN build_attempts attempt
             ON attempt.attempt_id = b.active_attempt_id AND attempt.build_id = b.build_id
           WHERE b.build_key = ? AND b.status = 'succeeded' AND b.artifact_digest = ?
             AND COALESCE(json_extract(b.failure_json, '$.code'), '') <> 'ARTIFACT_CONFLICT'
             AND attempt.status = 'succeeded' AND attempt.manifest_digest = ?
             AND NOT EXISTS (
               SELECT 1 FROM artifacts existing
               WHERE existing.build_key = b.build_key AND existing.status = 'admitted'
             )`,
      )
      .bind(
        artifact.image.digest,
        artifact.image.digest,
        artifact.image.platformManifestDigest,
        artifact.compositionManifest.digest,
        artifact.producerRevision,
        JSON.stringify(artifact.buildInput.requestedModules),
        JSON.stringify(artifact.resolvedModules),
        JSON.stringify(contractVersions),
        JSON.stringify(verification),
        JSON.stringify(evidence.statement),
        JSON.stringify(evidence.signature),
        now,
        now,
        build.build_key,
        artifact.image.digest,
        artifact.image.digest,
      );
  }
}

function updateCacheMetadata(
  verification: VerificationJson,
  existing: BuildArtifactCacheRecord,
  next: BuildArtifactCacheRecord,
): VerificationJson {
  const prior = verification.cache;
  const existingArtifacts =
    existing.state === "admitted" ? [existing.artifact] : existing.artifacts;
  const baseIdentity =
    existingArtifacts[0] === undefined ? "" : outputIdentity(existingArtifacts[0]);
  const evidence =
    next.state === "admitted"
      ? next.attestations
          .filter(
            (item) =>
              !existingArtifacts.some((old) => admissionIdentity(item) === admissionIdentity(old)),
          )
          .map(toEvidence)
      : next.artifacts.filter((item) => outputIdentity(item) !== baseIdentity).map(toEvidence);
  const cache: NonNullable<VerificationJson["cache"]> =
    next.state === "admitted"
      ? {
          lastHitAt: prior?.lastHitAt ?? null,
          attestations: evidence,
          conflicts: [],
        }
      : {
          lastHitAt: prior?.lastHitAt ?? null,
          attestations: prior?.attestations ?? [],
          conflicts: evidence,
          conflictAt: prior?.conflictAt ?? next.conflictAt,
        };
  return { ...verification, cache };
}

function artifactFromEvidence(
  evidence: CacheEvidence,
  buildInput: ReturnType<typeof BuildInputSchema.parse>,
  row: ArtifactRow,
  requireStoredIdentity: boolean,
): VerifiedArtifact | null {
  const statement = BuilderArtifactStatementSchema.safeParse(evidence.statement);
  const signature = BuilderSignatureSchema.safeParse(evidence.signature);
  if (
    !statement.success ||
    !signature.success ||
    !isSha256Digest(row.artifact_digest) ||
    !isSha256Digest(row.build_key) ||
    !isSha256Digest(statement.data.artifact.digest) ||
    statement.data.buildKey !== row.build_key ||
    !isEd25519Signature(signature.data.signature) ||
    (requireStoredIdentity && statement.data.artifact.digest !== row.artifact_digest) ||
    (requireStoredIdentity && statement.data.artifact.digest !== row.manifest_digest) ||
    (requireStoredIdentity &&
      statement.data.artifact.platformManifestDigest !== row.platform_manifest_digest) ||
    (requireStoredIdentity &&
      statement.data.compositionManifest.digest !== row.composition_manifest_digest) ||
    (requireStoredIdentity && statement.data.producerRevision !== row.producer_revision) ||
    statement.data.artifact.platform !== buildInput.platform ||
    evidence.signerKeyId !== signature.data.keyId ||
    !validCount(evidence.reachableLayerBytes) ||
    !validCount(evidence.compositionManifestBytes) ||
    !Number.isFinite(Date.parse(evidence.verifiedAt))
  ) {
    return null;
  }
  try {
    const storedModules = JSON.parse(row.resolved_modules_json) as unknown;
    if (JSON.stringify(storedModules) !== JSON.stringify(statement.data.resolvedModules))
      return null;
    if (
      canonicalBuildInput({ ...buildInput, resolvedModules: statement.data.resolvedModules }) !==
      canonicalBuildInput(buildInput)
    )
      return null;
  } catch {
    return null;
  }

  return {
    schemaVersion: 1,
    buildKey: statement.data.buildKey as Sha256Digest,
    buildInput,
    image: {
      repository: statement.data.artifact.repository,
      digest: statement.data.artifact.digest as Sha256Digest,
      reference: `${statement.data.artifact.repository}@${statement.data.artifact.digest}`,
      platformManifestDigest: statement.data.artifact.platformManifestDigest as Sha256Digest,
      platform: statement.data.artifact.platform,
    },
    compositionManifest: {
      ...statement.data.compositionManifest,
      digest: statement.data.compositionManifest.digest as Sha256Digest,
    },
    producerRevision: statement.data.producerRevision,
    resolvedModules: statement.data.resolvedModules,
    contractVersion: statement.data.contractVersion,
    issuedAt: statement.data.issuedAt,
    signerKeyId: signature.data.keyId,
    signature: signature.data,
    verifiedAt: evidence.verifiedAt,
    reachableLayerBytes: evidence.reachableLayerBytes,
    compositionManifestBytes: evidence.compositionManifestBytes,
  };
}

function toEvidence(artifact: VerifiedArtifact): CacheEvidence {
  return {
    statement: {
      schemaVersion: "praetorium.build-artifact/v1",
      buildKey: artifact.buildKey,
      artifact: {
        repository: artifact.image.repository,
        digest: artifact.image.digest,
        platformManifestDigest: artifact.image.platformManifestDigest,
        platform: artifact.image.platform,
      },
      compositionManifest: artifact.compositionManifest,
      producerRevision: artifact.producerRevision,
      resolvedModules: artifact.resolvedModules,
      contractVersion: artifact.contractVersion as "scriptorium-build/v1",
      issuedAt: artifact.issuedAt,
    },
    signature: artifact.signature,
    verifiedAt: artifact.verifiedAt,
    signerKeyId: artifact.signerKeyId,
    reachableLayerBytes: artifact.reachableLayerBytes,
    compositionManifestBytes: artifact.compositionManifestBytes,
  };
}

async function parseBuildInput(
  value: string,
  expectedKey: string,
): Promise<ReturnType<typeof BuildInputSchema.parse>> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("persisted build input is not valid JSON");
  }
  const input = BuildInputSchema.parse(decoded);
  if (canonicalBuildInput(input) !== value || (await computeBuildKey(input)) !== expectedKey) {
    throw new Error("persisted build input does not match its build key");
  }
  return input;
}

function parseVerificationJson(value: string): VerificationJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("persisted artifact verification is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("persisted artifact verification is not an object");
  }
  const result = parsed as Record<string, unknown>;
  if (
    result.schemaVersion !== 1 ||
    typeof result.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(result.verifiedAt)) ||
    typeof result.signerKeyId !== "string" ||
    !validCount(result.reachableLayerBytes) ||
    !validCount(result.compositionManifestBytes)
  ) {
    throw new Error("persisted artifact verification fields are invalid");
  }
  const rawCache = result.cache;
  if (
    rawCache !== undefined &&
    (typeof rawCache !== "object" || rawCache === null || Array.isArray(rawCache))
  ) {
    throw new Error("persisted artifact cache metadata is invalid");
  }
  const cache = rawCache as Record<string, unknown> | undefined;
  if (cache) {
    for (const field of ["attestations", "conflicts"] as const) {
      if (cache[field] !== undefined && !Array.isArray(cache[field])) {
        throw new Error(`persisted artifact cache ${field} is invalid`);
      }
    }
    if (
      cache.lastHitAt !== undefined &&
      cache.lastHitAt !== null &&
      typeof cache.lastHitAt !== "string"
    ) {
      throw new Error("persisted artifact cache hit time is invalid");
    }
    if (cache.conflictAt !== undefined && typeof cache.conflictAt !== "string") {
      throw new Error("persisted artifact cache conflict time is invalid");
    }
  }
  if (cache) {
    for (const field of ["attestations", "conflicts"] as const) {
      for (const item of (cache[field] as readonly unknown[] | undefined) ?? []) {
        if (!parseCacheEvidence(item))
          throw new Error(`persisted artifact cache ${field} evidence is invalid`);
      }
    }
  }
  return result as VerificationJson;
}

function parseCacheEvidence(value: unknown): CacheEvidence | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const statement = BuilderArtifactStatementSchema.safeParse(candidate.statement);
  const signature = BuilderSignatureSchema.safeParse(candidate.signature);
  if (
    !statement.success ||
    !signature.success ||
    typeof candidate.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.verifiedAt)) ||
    candidate.signerKeyId !== signature.data.keyId ||
    !validCount(candidate.reachableLayerBytes) ||
    !validCount(candidate.compositionManifestBytes)
  )
    return null;
  return candidate as unknown as CacheEvidence;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`persisted ${label} is not valid JSON`);
  }
}

function isArtifactConflict(build: BuildRow): boolean {
  if (build.failure_json === null) return false;
  try {
    const failure = JSON.parse(build.failure_json) as { code?: unknown };
    return failure.code === "ARTIFACT_CONFLICT";
  } catch {
    return false;
  }
}

function conflictRecord(
  buildKey: Sha256Digest,
  artifacts: readonly VerifiedArtifact[] | null,
  conflictAt: number | string,
): BuildArtifactCacheRecord {
  return {
    state: "conflict",
    buildKey,
    artifacts: artifacts ?? [],
    conflictAt:
      typeof conflictAt === "number"
        ? timestampIso(conflictAt, "conflict time")
        : canonicalIsoTime(conflictAt, "conflict time"),
  };
}

function outputIdentity(artifact: VerifiedArtifact): string {
  return JSON.stringify({
    buildKey: artifact.buildKey,
    image: [
      artifact.image.repository,
      artifact.image.digest,
      artifact.image.platformManifestDigest,
      artifact.image.platform,
    ],
    buildInput: artifact.buildInput,
    compositionManifest: [
      artifact.compositionManifest.repository,
      artifact.compositionManifest.digest,
    ],
    producerRevision: artifact.producerRevision,
    resolvedModules: artifact.resolvedModules.map(({ id, version, artifactDigest }) => [
      id,
      version,
      artifactDigest,
    ]),
    contractVersion: artifact.contractVersion,
  });
}

function admissionIdentity(artifact: VerifiedArtifact): string {
  return `${artifact.signerKeyId}\u0000${artifact.signature.signature}\u0000${artifact.issuedAt}`;
}

async function validateVerifiedArtifact(artifact: VerifiedArtifact): Promise<void> {
  if (
    !isSha256Digest(artifact.buildKey) ||
    !isSha256Digest(artifact.image.digest) ||
    !isSha256Digest(artifact.image.platformManifestDigest) ||
    !isSha256Digest(artifact.compositionManifest.digest) ||
    !isEd25519Signature(artifact.signature.signature) ||
    artifact.signerKeyId !== artifact.signature.keyId ||
    artifact.image.reference !== `${artifact.image.repository}@${artifact.image.digest}` ||
    artifact.image.platform !== artifact.buildInput.platform ||
    artifact.producerRevision !== artifact.buildInput.producerRevision ||
    !Number.isFinite(Date.parse(artifact.issuedAt)) ||
    !Number.isFinite(Date.parse(artifact.verifiedAt)) ||
    !validCount(artifact.reachableLayerBytes) ||
    !validCount(artifact.compositionManifestBytes)
  ) {
    throw new TypeError("cache artifact key and image digest must be immutable sha256 values");
  }
  const statement = BuilderArtifactStatementSchema.safeParse(toEvidence(artifact).statement);
  const signature = BuilderSignatureSchema.safeParse(artifact.signature);
  if (
    !statement.success ||
    !signature.success ||
    (await computeBuildKey(artifact.buildInput)) !== artifact.buildKey ||
    canonicalBuildInput({
      ...artifact.buildInput,
      resolvedModules: artifact.resolvedModules,
    }) !== canonicalBuildInput(artifact.buildInput)
  ) {
    throw new TypeError("cache artifact signed evidence is malformed");
  }
}

function isEd25519Signature(value: string): boolean {
  try {
    return atob(value).length === 64;
  } catch {
    return false;
  }
}

function validateBuildKey(buildKey: string): asserts buildKey is Sha256Digest {
  if (!isSha256Digest(buildKey))
    throw new TypeError("build key must be an immutable sha256 digest");
}

function safeIsoTime(clock: () => Date): string {
  const date = clock();
  if (!Number.isFinite(date.getTime()))
    throw new TypeError("artifact cache clock returned an invalid time");
  return date.toISOString();
}

function canonicalIsoTime(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    throw new TypeError(`${label} is invalid`);
  return value;
}

function timestampIso(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} is invalid`);
  return new Date(value).toISOString();
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTransactionAssertion(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("platform_transaction_sentinel") || /UNIQUE constraint failed/iu.test(message)
  );
}

const GC_SNAPSHOT_SQL = `
WITH live_references(digest, reason) AS (
  SELECT current_artifact_digest, 'running' FROM logical_instances
    WHERE current_artifact_digest IS NOT NULL
  UNION ALL
  SELECT desired_artifact_digest, 'desired' FROM logical_instances
    WHERE desired_artifact_digest IS NOT NULL
  UNION ALL
  SELECT previous.artifact_digest, 'rollback'
    FROM operations active
    JOIN deployment_revisions target ON target.revision_id = active.deployment_revision_id
      AND target.instance_id = active.instance_id AND target.repository_id = active.repository_id
    JOIN deployment_revisions previous ON previous.instance_id = active.instance_id
      AND previous.status = 'admitted' AND previous.artifact_digest IS NOT NULL
      AND previous.generation < target.generation
    WHERE active.status IN ('claimed', 'running') AND active.kind IN ('redeploy', 'update')
), cache_entries AS (
  SELECT a.* FROM artifacts a JOIN builds b ON b.build_key = a.build_key
    WHERE a.status = 'admitted' AND b.status = 'succeeded'
      AND b.artifact_digest = a.artifact_digest
      AND COALESCE(json_extract(b.failure_json, '$.code'), '') <> 'ARTIFACT_CONFLICT'
      AND COALESCE(json_array_length(json_extract(a.verification_json, '$.cache.conflicts')), 0) = 0
)
SELECT 'artifact' AS row_kind,
       a.artifact_digest, a.build_key, a.manifest_digest, a.platform_manifest_digest,
       a.composition_manifest_digest, a.producer_revision, a.resolved_modules_json,
       a.verification_json, a.statement_json, a.signature_json, a.status, a.created_at, a.admitted_at,
       b.build_input_json, NULL AS reference_digest, NULL AS reference_reason
  FROM cache_entries a JOIN builds b ON b.build_key = a.build_key
UNION ALL
SELECT 'reference' AS row_kind,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, digest AS reference_digest, reason AS reference_reason
  FROM live_references
`;
