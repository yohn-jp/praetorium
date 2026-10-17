import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildKey as computeBuildKey,
  canonicalBuildInput,
  type BuildInput,
  type BuilderArtifactStatement,
} from "@praetorium/contracts";
import type { Sha256Digest, VerifiedArtifact } from "@praetorium/application/artifacts";
import {
  D1ArtifactCacheStore,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
} from "@praetorium/persistence/d1";
import { planCacheMaintenance } from "./cache-maintenance.js";

const schemaUrl = new URL(
  "../../../apps/control-plane/migrations/0001_repository_platform.sql",
  import.meta.url,
);
const liveDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of liveDatabases.splice(0)) database.close();
});

describe("cache maintenance advisory planning", () => {
  it("uses the current D1 pin snapshot, protects conflicts, and audits only a bounded advisory plan", async () => {
    const { database, db, cacheStore } = createStore();
    const running = await seedArtifact(database, "build-running", "attempt-running", "a", "a");
    const rollback = await seedArtifact(database, "build-rollback", "attempt-rollback", "c", "c");
    const desired = await seedArtifact(database, "build-desired", "attempt-desired", "d", "d");
    const unpinned = await seedArtifact(database, "build-unpinned", "attempt-unpinned", "e", "e");
    seedInstanceAndRevisions(database, running, rollback, desired);
    database
      .prepare(
        `UPDATE builds SET status = 'failed', artifact_digest = NULL,
         failure_json = '{"code":"ARTIFACT_CONFLICT","retryable":false}', updated_at = 200
         WHERE build_key = ?`,
      )
      .run(running.buildKey);

    const result = await planCacheMaintenance({
      db,
      cacheStore,
      policy: { maxBytes: 150, maxEntries: 1, minAgeMs: 0, maxEvictions: 32 },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      action: "build-cache.gc.planned",
      budgetScope: "admitted-cache-snapshot",
      advisoryOnly: true,
      deletionAuthorized: false,
      deletionAttempted: false,
      overBudget: true,
      overBudgetAfterPlan: true,
      entriesBefore: 3,
      estimatedBytesBefore: 360,
      entriesAfterPlan: 2,
      estimatedBytesAfterPlan: 240,
      referenceCounts: { running: 1, desired: 1, rollback: 2 },
      candidateBuildKeys: [unpinned.buildKey],
      candidateManifestDigests: [unpinned.image.digest],
    });
    expect(result.references).toEqual(
      expect.arrayContaining([
        { digest: running.image.digest, reason: "running" },
        { digest: running.image.digest, reason: "rollback" },
        { digest: rollback.image.digest, reason: "rollback" },
        { digest: desired.image.digest, reason: "desired" },
      ]),
    );
    expect(result.candidateBuildKeys).not.toContain(running.buildKey);

    const audit = database
      .prepare(
        `SELECT actor_id, actor_kind, action, outcome, request_id, metadata_json
         FROM audit_events WHERE event_id = ?`,
      )
      .get(result.auditEventId) as
      | {
          actor_id: string;
          actor_kind: string;
          action: string;
          outcome: string;
          request_id: string;
          metadata_json: string;
        }
      | undefined;
    expect(audit).toMatchObject({
      actor_id: "system:build-cache-maintenance",
      actor_kind: "system",
      action: "build-cache.gc.planned",
      outcome: "planned",
      request_id: `cache-maintenance:${result.auditEventId}`,
    });
    const metadata = JSON.parse(audit!.metadata_json) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      budgetScope: "admitted-cache-snapshot",
      advisoryOnly: true,
      deletionAuthorized: false,
      deletionAttempted: false,
      overBudget: true,
      overBudgetAfterPlan: true,
      candidateBuildKeyCount: 1,
      candidateBuildKeys: [unpinned.buildKey],
      candidateManifestDigestCount: 1,
      candidateManifestDigests: [unpinned.image.digest],
      references: { running: 1, desired: 1, rollback: 2 },
    });
    expect(audit!.metadata_json.length).toBeLessThan(8_192);
    expect(audit!.metadata_json).not.toMatch(/token|secret|credential/iu);
    expect(database.prepare("SELECT count(*) AS count FROM artifacts").get()).toMatchObject({
      count: 4,
    });
  });

  it("rejects unbounded or extended retention policy before reading or auditing", async () => {
    const { database, db, cacheStore } = createStore();
    const readSnapshot = vi.fn(cacheStore.getGarbageCollectionSnapshot.bind(cacheStore));

    await expect(
      planCacheMaintenance({
        db,
        cacheStore: { getGarbageCollectionSnapshot: readSnapshot },
        policy: { maxBytes: 0, maxEntries: 1, minAgeMs: 0, maxEvictions: 33 },
        now: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/maxEvictions/u);
    await expect(
      planCacheMaintenance({
        db,
        cacheStore: { getGarbageCollectionSnapshot: readSnapshot },
        policy: {
          maxBytes: 0,
          maxEntries: 1,
          minAgeMs: 0,
          maxEvictions: 1,
          registryToken: "never-accepted",
        } as never,
        now: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/unknown fields/u);

    expect(readSnapshot).not.toHaveBeenCalled();
    expect(database.prepare("SELECT count(*) AS count FROM audit_events").get()).toMatchObject({
      count: 0,
    });
  });
});

function createStore(): {
  readonly database: DatabaseSync;
  readonly db: D1Database;
  readonly cacheStore: D1ArtifactCacheStore;
} {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(readFileSync(schemaUrl, "utf8"));
  liveDatabases.push(database);
  const db = new SQLiteD1Database(database);
  return { database, db, cacheStore: new D1ArtifactCacheStore(db) };
}

async function seedArtifact(
  database: DatabaseSync,
  buildId: string,
  attemptId: string,
  inputSeed: string,
  outputSeed: string,
): Promise<VerifiedArtifact> {
  const input = makeInput(inputSeed);
  const key = (await computeBuildKey(input)) as Sha256Digest;
  const artifact = makeArtifact(input, key, outputSeed, outputSeed);
  const createdAt = 100;
  database
    .prepare(
      `INSERT INTO builds (
         build_id, build_key, build_input_json, status, attempt_count, lease_epoch,
         active_attempt_id, report_sequence, cancel_requested, artifact_digest, created_at, updated_at
       ) VALUES (?, ?, ?, 'succeeded', 1, 1, ?, 1, 0, ?, ?, ?)`,
    )
    .run(
      buildId,
      key,
      canonicalBuildInput(input),
      attemptId,
      artifact.image.digest,
      createdAt,
      createdAt,
    );
  database
    .prepare(
      `INSERT INTO build_attempts (
         attempt_id, build_id, lease_epoch, worker_id, status, lease_token, lease_expires_at,
         report_sequence, manifest_digest, started_at, updated_at, finished_at
       ) VALUES (?, ?, 1, 'worker-1', 'succeeded', 'lease-1', 200, 1, ?, ?, ?, ?)`,
    )
    .run(attemptId, buildId, artifact.image.digest, createdAt, createdAt, createdAt);
  database
    .prepare(
      `INSERT INTO artifacts (
         artifact_digest, build_key, build_id, attempt_id, manifest_digest,
         platform_manifest_digest, composition_manifest_digest, producer_revision,
         requested_modules_json, resolved_modules_json, contract_versions_json, sbom_ref,
         provenance_ref, verification_json, statement_json, signature_json, verifier_id,
         status, created_at, admitted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?,
         'control-plane-artifact-admission', 'admitted', ?, ?)`,
    )
    .run(
      artifact.image.digest,
      key,
      buildId,
      attemptId,
      artifact.image.digest,
      artifact.image.platformManifestDigest,
      artifact.compositionManifest.digest,
      artifact.producerRevision,
      JSON.stringify(input.requestedModules),
      JSON.stringify(artifact.resolvedModules),
      JSON.stringify({
        build: artifact.contractVersion,
        composition: "scriptorium-composition/v1",
      }),
      JSON.stringify({
        schemaVersion: 1,
        verifiedAt: artifact.verifiedAt,
        signerKeyId: artifact.signerKeyId,
        reachableLayerBytes: artifact.reachableLayerBytes,
        compositionManifestBytes: artifact.compositionManifestBytes,
      }),
      JSON.stringify(statementFromArtifact(artifact)),
      JSON.stringify(artifact.signature),
      createdAt,
      createdAt,
    );
  return artifact;
}

function makeInput(seed: string): BuildInput {
  return {
    contractVersion: "scriptorium-build/v1",
    producerRevision: "1".repeat(40),
    runtimeBaseDigest: digest("1"),
    buildKitDigest: digest("2"),
    recipeDigest: digest("3"),
    sourceDigest: digest(seed),
    lockDigest: digest("4"),
    requestedModules: ["core"],
    resolvedModules: [{ id: "core", version: "1.0.0", artifactDigest: digest("5") }],
    platform: "linux/amd64",
    options: {},
  };
}

function makeArtifact(
  buildInput: BuildInput,
  buildKey: Sha256Digest,
  imageSeed: string,
  compositionSeed: string,
): VerifiedArtifact {
  const imageDigest = digest(imageSeed);
  const signature = {
    algorithm: "Ed25519" as const,
    keyId: "builder-test",
    signature: signatureBytes(1),
  };
  return {
    schemaVersion: 1,
    buildKey,
    buildInput,
    image: {
      repository: "derived/test",
      digest: imageDigest,
      reference: `derived/test@${imageDigest}`,
      platformManifestDigest: digest(imageSeed.toUpperCase()),
      platform: buildInput.platform,
    },
    compositionManifest: {
      repository: "derived/test-composition",
      digest: digest(compositionSeed),
    },
    producerRevision: buildInput.producerRevision,
    resolvedModules: buildInput.resolvedModules,
    contractVersion: "scriptorium-build/v1",
    issuedAt: "2026-01-01T00:00:00.000Z",
    signerKeyId: signature.keyId,
    signature,
    verifiedAt: "2026-01-01T00:00:01.000Z",
    reachableLayerBytes: 100,
    compositionManifestBytes: 20,
  };
}

function statementFromArtifact(artifact: VerifiedArtifact): BuilderArtifactStatement {
  return {
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
    contractVersion: "scriptorium-build/v1",
    issuedAt: artifact.issuedAt,
  };
}

function seedInstanceAndRevisions(
  database: DatabaseSync,
  previous: VerifiedArtifact,
  intermediate: VerifiedArtifact,
  target: VerifiedArtifact,
): void {
  database
    .prepare(
      `INSERT INTO logical_instances (
         instance_id, repository_id, generation, runtime_epoch, desired_state, policy,
         observed_generation, observed_runtime_epoch, observed_sequence, observed_state,
         desired_revision_id, observed_revision_id, desired_artifact_digest, current_artifact_digest,
         created_at, updated_at
       ) VALUES ('instance-1', 71, 3, 2, 'running', 'stable', 1, 1, 1, 'ready',
         'revision-new', 'revision-old', ?, ?, 100, 200)`,
    )
    .run(target.image.digest, previous.image.digest);
  for (const [revisionId, generation, artifact] of [
    ["revision-old", 1, previous],
    ["revision-middle", 2, intermediate],
    ["revision-new", 3, target],
  ] as const) {
    const build = database
      .prepare("SELECT build_id FROM builds WHERE build_key = ?")
      .get(artifact.buildKey) as { build_id: string } | undefined;
    if (!build) throw new Error("test artifact build row is missing");
    database
      .prepare(
        `INSERT INTO deployment_revisions (
           revision_id, instance_id, repository_id, generation, build_key, build_id,
           selection_json, resource_requirements_json, runtime_metadata_json, artifact_digest,
           status, actor_id, created_at
         ) VALUES (?, 'instance-1', 71, ?, ?, ?, '{}', '{}', '{}', ?, 'admitted', 'actor-1', 100)`,
      )
      .run(revisionId, generation, artifact.buildKey, build.build_id, artifact.image.digest);
  }
  database
    .prepare(
      `INSERT INTO operations (
         operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status, phase,
         attempt, lease_epoch, report_sequence, checkpoint_sequence, deployment_revision_id,
         idempotency_scope, idempotency_key, request_hash, actor_id, authorization_revision,
         created_at, updated_at
       ) VALUES ('operation-1', 'instance-1', 71, 3, 2, 'update', 'running', 'starting-target',
         1, 1, 0, 0, 'revision-new', 'repository:71', 'update-1', 'request-hash', 'actor-1', 0, 200, 200)`,
    )
    .run();
}

function digest(seed: string): Sha256Digest {
  const character = seed.toLowerCase()[0];
  if (!character || !/[a-f0-9]/u.test(character)) throw new Error("invalid test digest seed");
  return `sha256:${character.repeat(64)}`;
}

function signatureBytes(byte: number): string {
  return btoa(String.fromCharCode(...new Array<number>(64).fill(byte)));
}

class SQLiteD1Database implements D1Database {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    return new SQLiteD1Statement(this.database, query);
  }

  async batch<T>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) results.push(await statement.run<T>());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class SQLiteD1Statement implements D1PreparedStatement {
  private values: readonly SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
  ) {}

  bind(
    ...values: readonly (string | number | null | ArrayBuffer | Uint8Array)[]
  ): D1PreparedStatement {
    this.values = values.map((value) =>
      value instanceof ArrayBuffer ? new Uint8Array(value) : value,
    );
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      results: this.database.prepare(this.query).all(...this.values) as T[],
      meta: { changes: 0 },
    };
  }

  async run<T>(): Promise<D1Result<T>> {
    const result = this.database.prepare(this.query).run(...this.values);
    return { results: [], meta: { changes: Number(result.changes) } };
  }
}
