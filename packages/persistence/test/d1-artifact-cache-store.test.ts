import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildKey as computeBuildKey,
  canonicalBuildInput,
  type BuildInput,
  type BuilderArtifactStatement,
} from "@praetorium/contracts";
import { planCacheGarbageCollection } from "@praetorium/application/build-cache";
import type { Sha256Digest, VerifiedArtifact } from "@praetorium/application/artifacts";
import { D1ArtifactCacheStore } from "../src/d1/artifact-cache-store.js";
import type { D1Database, D1PreparedStatement, D1Result } from "../src/d1/types.js";

const schemaUrl = new URL(
  "../../../apps/control-plane/migrations/0001_repository_platform.sql",
  import.meta.url,
);
const liveDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of liveDatabases.splice(0)) database.close();
});

describe("D1ArtifactCacheStore against the repository SQLite schema", () => {
  it("round-trips admitted evidence and keeps cache hit times monotonic", async () => {
    const { database, store } = createStore();
    const artifact = await seedArtifact(database, "build-a", "attempt-a", "a", "a");
    const rotated = {
      ...artifact,
      signerKeyId: "builder-b",
      signature: { ...artifact.signature, keyId: "builder-b", signature: signatureBytes(2) },
      verifiedAt: "2026-01-01T00:00:02.000Z",
    };

    await expect(store.findByBuildKey(artifact.buildKey)).resolves.toMatchObject({
      state: "admitted",
      artifact: { image: { digest: artifact.image.digest } },
      attestations: [{ signerKeyId: "builder-a" }],
    });
    await expect(store.recordVerifiedArtifact(rotated)).resolves.toMatchObject({
      state: "admitted",
      attestations: [{ signerKeyId: "builder-a" }, { signerKeyId: "builder-b" }],
    });
    await store.recordCacheHit(artifact.buildKey, "2026-01-01T00:00:05.000Z");
    await store.recordCacheHit(artifact.buildKey, "2026-01-01T00:00:04.000Z");

    await expect(store.findByBuildKey(artifact.buildKey)).resolves.toMatchObject({
      state: "admitted",
      attestations: [{ signerKeyId: "builder-a" }, { signerKeyId: "builder-b" }],
      lastHitAt: "2026-01-01T00:00:05.000Z",
    });
    expect(
      database
        .prepare("SELECT status, artifact_digest FROM artifacts WHERE build_key = ?")
        .get(artifact.buildKey),
    ).toMatchObject({
      status: "admitted",
      artifact_digest: artifact.image.digest,
    });
  });

  it("permanently quarantines a divergent verified output without replacing the admitted digest", async () => {
    const { database, store } = createStore();
    const admitted = await seedArtifact(database, "build-a", "attempt-a", "a", "a");
    const divergent = makeArtifact(admitted.buildInput, admitted.buildKey, "b", "b", "builder-b");

    await expect(store.recordVerifiedArtifact(divergent)).resolves.toMatchObject({
      state: "conflict",
      artifacts: [
        { image: { digest: admitted.image.digest } },
        { image: { digest: divergent.image.digest } },
      ],
    });
    await expect(store.findByBuildKey(admitted.buildKey)).resolves.toMatchObject({
      state: "conflict",
    });
    await expect(
      store.recordCacheHit(admitted.buildKey, "2026-01-01T00:00:05.000Z"),
    ).rejects.toThrow(/admitted cache entry/u);
    expect(
      database
        .prepare("SELECT status, artifact_digest FROM artifacts WHERE build_key = ?")
        .get(admitted.buildKey),
    ).toMatchObject({
      status: "admitted",
      artifact_digest: admitted.image.digest,
    });
    await expect(store.listAdmittedArtifacts()).resolves.toEqual([]);
  });

  it("maps D1BuildStore ARTIFACT_CONFLICT failures to cache quarantine while retaining deployment pins", async () => {
    const { database, store } = createStore();
    const admitted = await seedArtifact(database, "build-old", "attempt-old", "a", "a");
    const intermediate = await seedArtifact(
      database,
      "build-middle",
      "attempt-middle",
      "c",
      "c",
      "2",
    );
    const desired = await seedArtifact(database, "build-new", "attempt-new", "d", "d", "3");
    seedInstanceAndRevisions(database, admitted, intermediate, desired);
    database
      .prepare(
        `UPDATE builds SET status = 'failed', artifact_digest = NULL,
         failure_json = '{"code":"ARTIFACT_CONFLICT","retryable":false}', updated_at = 200
       WHERE build_key = ?`,
      )
      .run(admitted.buildKey);

    await expect(store.findByBuildKey(admitted.buildKey)).resolves.toMatchObject({
      state: "conflict",
      artifacts: [{ image: { digest: admitted.image.digest } }],
    });
    const snapshot = await store.getGarbageCollectionSnapshot();
    expect(snapshot.entries.map((entry) => entry.buildKey).sort()).toEqual(
      [intermediate.buildKey, desired.buildKey].sort(),
    );
    expect(snapshot.references).toEqual(
      expect.arrayContaining([
        { digest: admitted.image.digest, reason: "running" },
        { digest: admitted.image.digest, reason: "rollback" },
        { digest: intermediate.image.digest, reason: "rollback" },
        { digest: desired.image.digest, reason: "desired" },
      ]),
    );
    const plan = planCacheGarbageCollection(snapshot.entries, snapshot.references, {
      now: "2026-01-01T00:00:00.000Z",
      maxBytes: 0,
      maxEntries: 1,
      minAgeMs: 0,
      maxEvictions: 10,
    });
    expect(plan.evictedBuildKeys).toEqual([]);
    expect(plan.deletableManifestDigests).toEqual([]);
  });

  it("does not create cache admission before the canonical D1 build report exists", async () => {
    const { store } = createStore();
    const input = makeInput("d");
    const key = (await computeBuildKey(input)) as Sha256Digest;
    const artifact = makeArtifact(input, key, "d", "d");
    await expect(store.recordVerifiedArtifact(artifact)).rejects.toThrow(
      /D1BuildStore must persist/u,
    );
  });

  it("restores a missing artifact row only from its matching successful D1 attempt", async () => {
    const { database, store } = createStore();
    const artifact = await seedArtifact(database, "build-a", "attempt-a", "a", "a");
    database.prepare("DELETE FROM artifacts WHERE artifact_digest = ?").run(artifact.image.digest);

    await expect(store.recordVerifiedArtifact(artifact)).resolves.toMatchObject({
      state: "admitted",
      buildKey: artifact.buildKey,
      artifact: { image: { digest: artifact.image.digest } },
    });
    expect(
      database
        .prepare("SELECT status, artifact_digest FROM artifacts WHERE build_key = ?")
        .get(artifact.buildKey),
    ).toMatchObject({ status: "admitted", artifact_digest: artifact.image.digest });
  });
});

function createStore(): { readonly database: DatabaseSync; readonly store: D1ArtifactCacheStore } {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(readFileSync(schemaUrl, "utf8"));
  liveDatabases.push(database);
  return {
    database,
    store: new D1ArtifactCacheStore(
      new SqliteD1Database(database),
      () => new Date("2026-01-01T00:00:03.000Z"),
    ),
  };
}

async function seedArtifact(
  database: DatabaseSync,
  buildId: string,
  attemptId: string,
  inputSeed: string,
  outputSeed: string,
  producerSeed = "1",
): Promise<VerifiedArtifact> {
  const input = makeInput(inputSeed, producerSeed);
  const buildKey = (await computeBuildKey(input)) as Sha256Digest;
  const artifact = makeArtifact(input, buildKey, outputSeed, outputSeed, "builder-a");
  const inputJson = canonicalBuildInput(input);
  const createdAt = 100;
  database
    .prepare(
      `INSERT INTO builds (
       build_id, build_key, build_input_json, status, attempt_count, lease_epoch,
       active_attempt_id, report_sequence, cancel_requested, artifact_digest, created_at, updated_at
     ) VALUES (?, ?, ?, 'succeeded', 1, 1, ?, 1, 0, ?, ?, ?)`,
    )
    .run(buildId, buildKey, inputJson, attemptId, artifact.image.digest, createdAt, createdAt);
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
      buildKey,
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

function makeInput(seed: string, producerSeed = "1"): BuildInput {
  return {
    contractVersion: "scriptorium-build/v1",
    producerRevision: producerSeed.repeat(40),
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
  signer = "builder-a",
): VerifiedArtifact {
  const imageDigest = digest(imageSeed);
  const signature = {
    algorithm: "Ed25519" as const,
    keyId: signer,
    signature: signatureBytes(signer === "builder-a" ? 1 : 2),
  };
  return {
    schemaVersion: 1,
    buildKey,
    buildInput,
    image: {
      repository: "derived/app",
      digest: imageDigest,
      reference: `derived/app@${imageDigest}`,
      platformManifestDigest: digest(imageSeed.toUpperCase()),
      platform: buildInput.platform,
    },
    compositionManifest: { repository: "derived/app-composition", digest: digest(compositionSeed) },
    producerRevision: buildInput.producerRevision,
    resolvedModules: buildInput.resolvedModules,
    contractVersion: "scriptorium-build/v1",
    issuedAt: "2026-01-01T00:00:00.000Z",
    signerKeyId: signer,
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
  database
    .prepare(
      `INSERT INTO deployment_revisions (
       revision_id, instance_id, repository_id, generation, build_key, build_id,
       selection_json, resource_requirements_json, runtime_metadata_json, artifact_digest,
       status, actor_id, created_at
     ) VALUES ('revision-old', 'instance-1', 71, 1, ?, ?, '{}', '{}', '{}', ?, 'admitted', 'actor-1', 100)`,
    )
    .run(previous.buildKey, "build-old", previous.image.digest);
  database
    .prepare(
      `INSERT INTO deployment_revisions (
       revision_id, instance_id, repository_id, generation, build_key, build_id,
       selection_json, resource_requirements_json, runtime_metadata_json, artifact_digest,
       status, actor_id, created_at
     ) VALUES ('revision-middle', 'instance-1', 71, 2, ?, ?, '{}', '{}', '{}', ?, 'admitted', 'actor-1', 150)`,
    )
    .run(intermediate.buildKey, "build-middle", intermediate.image.digest);
  database
    .prepare(
      `INSERT INTO deployment_revisions (
       revision_id, instance_id, repository_id, generation, build_key, build_id,
       selection_json, resource_requirements_json, runtime_metadata_json, artifact_digest,
       status, actor_id, created_at
     ) VALUES ('revision-new', 'instance-1', 71, 3, ?, ?, '{}', '{}', '{}', ?, 'admitted', 'actor-1', 200)`,
    )
    .run(target.buildKey, "build-new", target.image.digest);
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
  if (!character || !/[a-f0-9]/u.test(character))
    throw new Error("test digest seed must start with hex");
  return `sha256:${character.repeat(64)}`;
}

function signatureBytes(byte: number): string {
  return btoa(String.fromCharCode(...new Array<number>(64).fill(byte)));
}

class SqliteD1Database implements D1Database {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1Statement(this.database, query, []);
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
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

class SqliteD1Statement implements D1PreparedStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly values: readonly SQLInputValue[],
  ) {}

  bind(
    ...values: readonly (string | number | null | ArrayBuffer | Uint8Array)[]
  ): D1PreparedStatement {
    return new SqliteD1Statement(this.database, this.query, values.map(sqlInput));
  }

  async first<T = unknown>(): Promise<T | null> {
    const row = this.database.prepare(this.query).get(...this.values);
    return (row as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const rows = this.database.prepare(this.query).all(...this.values) as T[];
    return { results: rows, success: true, meta: { changes: 0 } };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const result = this.database.prepare(this.query).run(...this.values);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  }
}

function sqlInput(value: string | number | null | ArrayBuffer | Uint8Array): SQLInputValue {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}
