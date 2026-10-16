import { buildKey as computeBuildKey, type BuildInput } from "@praetorium/contracts";
import { describe, expect, it } from "vitest";
import { sha256Digest, type Sha256Digest } from "../src/artifacts/digest.js";
import { ArtifactAdmissionError, ArtifactAdmissionService } from "../src/artifacts/admission.js";
import { BuildArtifactCache, BuildCacheConflictError, recordVerifiedArtifactTransition } from "../src/build-cache/cache.js";
import { planCacheGarbageCollection } from "../src/build-cache/gc.js";
import type {
  ArtifactCandidate,
  ArtifactRegistryProvider,
  BuilderArtifactStatement,
  BuilderSignatureVerifier,
  RegistryVerifiedImage,
  VerifiedArtifact,
} from "../src/artifacts/types.js";
import type {
  AdmittedBuildArtifactRecord,
  BuildArtifactCacheRecord,
  BuildArtifactCacheStore,
} from "../src/build-cache/types.js";

const digestA = `sha256:${"a".repeat(64)}` as const;
const digestB = `sha256:${"b".repeat(64)}` as const;
const digestC = `sha256:${"c".repeat(64)}` as const;
const digestD = `sha256:${"d".repeat(64)}` as const;
const digestE = `sha256:${"e".repeat(64)}` as const;

const buildInput: BuildInput = {
  contractVersion: "scriptorium-build/v1",
  producerRevision: "d".repeat(40),
  runtimeBaseDigest: digestA,
  buildKitDigest: digestB,
  recipeDigest: digestC,
  sourceDigest: digestD,
  lockDigest: digestE,
  requestedModules: ["core"],
  resolvedModules: [{ id: "core", version: "1.0.0", artifactDigest: digestB }],
  platform: "linux/amd64",
  options: {},
};

interface TestCandidate {
  readonly input: BuildInput;
  readonly buildKey: Sha256Digest;
  readonly value: ArtifactCandidate;
  readonly compositionBytes: Uint8Array;
  readonly compositionDigest: Sha256Digest;
}

async function candidate(overrides: Partial<BuilderArtifactStatement> = {}): Promise<TestCandidate> {
  const buildKey = (await computeBuildKey(buildInput)) as Sha256Digest;
  const composition = {
    schemaVersion: "scriptorium-composition/v1",
    buildInput,
    buildKey,
    producerRevision: buildInput.producerRevision,
    platform: buildInput.platform,
    resolvedModules: buildInput.resolvedModules,
    server: { entry: "dist/server.js", moduleIds: ["core"] },
    browser: { entry: "dist/browser.js", moduleIds: ["core"] },
    nativeDependencies: [],
    smoke: { id: "runtime-ready", healthPath: "/health", timeoutSeconds: 10 },
  };
  const compositionBytes = new TextEncoder().encode(JSON.stringify(composition));
  const compositionDigest = await sha256Digest(compositionBytes);
  const statement: BuilderArtifactStatement = {
    schemaVersion: "praetorium.build-artifact/v1",
    buildKey,
    artifact: {
      repository: "praetorium/derived",
      digest: digestA,
      platformManifestDigest: digestB,
      platform: "linux/amd64",
    },
    compositionManifest: { repository: "praetorium/derived", digest: compositionDigest },
    producerRevision: buildInput.producerRevision,
    resolvedModules: [{ id: "core", version: "1.0.0", artifactDigest: digestB }],
    contractVersion: "scriptorium-build/v1",
    issuedAt: "2026-10-17T00:00:00.000Z",
    ...overrides,
  };
  return {
    input: buildInput,
    buildKey,
    compositionBytes,
    compositionDigest,
    value: {
      statement,
      signature: { algorithm: "Ed25519", keyId: "operator-test-key", signature: btoa("x".repeat(64)) },
    },
  };
}

let currentCandidate: TestCandidate | null = null;

function registryProvider(): ArtifactRegistryProvider & { missingComposition: boolean; wrongCompositionBytes: boolean } {
  return {
    missingComposition: false,
    wrongCompositionBytes: false,
    async verifyImage(repository, manifestDigest, requestedPlatform): Promise<RegistryVerifiedImage> {
      const statement = currentCandidate?.value.statement;
      return {
        repository,
        manifestDigest: manifestDigest as typeof digestA,
        platformManifestDigest: statement?.artifact.digest === manifestDigest ? statement.artifact.platformManifestDigest : digestB,
        platform: requestedPlatform,
        configDigest: digestC,
        layerDescriptors: [{ digest: digestB, size: 12, mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" }],
        reachableLayerBytes: 12,
      };
    },
    async readBlob(repository, digest) {
      if (this.missingComposition) throw Object.assign(new Error("missing"), { reason: "not_found" });
      const bytes = this.wrongCompositionBytes
        ? new TextEncoder().encode('{"modules":[]}')
        : currentCandidate!.compositionBytes;
      return {
        digest: digest as typeof digestC,
        mediaType: "application/json",
        size: bytes.byteLength,
        bytes,
      };
    },
  };
}

const signer: BuilderSignatureVerifier = {
  async verify(_statement, signature) {
    return signature.signature === btoa("x".repeat(64))
      ? { verified: true, keyId: signature.keyId }
      : { verified: false, reason: "bad signer" };
  },
};

class MemoryCacheStore implements BuildArtifactCacheStore {
  readonly records = new Map<string, BuildArtifactCacheRecord>();

  async findByBuildKey(buildKey: Sha256Digest): Promise<BuildArtifactCacheRecord | null> {
    return this.records.get(buildKey) ?? null;
  }

  async recordVerifiedArtifact(artifact: VerifiedArtifact): Promise<BuildArtifactCacheRecord> {
    const record = recordVerifiedArtifactTransition(
      this.records.get(artifact.buildKey) ?? null,
      artifact,
      "2026-10-17T00:00:00.000Z",
    );
    this.records.set(artifact.buildKey, record);
    return record;
  }

  async recordCacheHit(buildKey: Sha256Digest, hitAt: string): Promise<void> {
    const existing = this.records.get(buildKey);
    if (existing?.state === "admitted") this.records.set(buildKey, { ...existing, lastHitAt: hitAt });
  }

  async listAdmittedArtifacts(): Promise<readonly AdmittedBuildArtifactRecord[]> {
    return [...this.records.values()].filter((record): record is AdmittedBuildArtifactRecord => record.state === "admitted");
  }
}

async function setup() {
  const provider = registryProvider();
  const store = new MemoryCacheStore();
  const admission = new ArtifactAdmissionService(provider, signer, () => new Date("2026-10-17T01:00:00.000Z"));
  const cache = new BuildArtifactCache(admission, store, () => new Date("2026-10-17T01:01:00.000Z"));
  return { provider, store, admission, cache };
}

describe("artifact admission and build cache", () => {
  it("admits matching signed OCI and composition bytes, then rechecks reachability on a hit", async () => {
    const { provider, store, cache } = await setup();
    const input = await candidate();
    currentCandidate = input;

    const admitted = await cache.admit(input.value, input.input);
    expect(admitted.image.reference).toBe(`praetorium/derived@${digestA}`);
    expect(admitted.signerKeyId).toBe("operator-test-key");
    expect(admitted.buildInput).toEqual(buildInput);
    expect(store.records.get(input.buildKey)?.state).toBe("admitted");
    await expect(cache.lookup(input.buildKey)).resolves.toMatchObject({ hit: true });

    provider.missingComposition = true;
    await expect(cache.lookup(input.buildKey)).resolves.toEqual({ hit: false, reason: "artifact_unreachable" });
    expect(store.records.get(input.buildKey)?.state).toBe("admitted");
  });

  it("rejects a bad signer or malformed composition before writing an admission record", async () => {
    const { provider, cache, store } = await setup();
    const input = await candidate();
    currentCandidate = input;
    const bad = { ...input.value, signature: { ...input.value.signature, signature: btoa("y".repeat(64)) } };

    await expect(cache.admit(bad, input.input)).rejects.toBeInstanceOf(ArtifactAdmissionError);
    expect(store.records.size).toBe(0);

    await expect(cache.admit(input.value, { ...input.input, sourceDigest: digestE }))
      .rejects.toMatchObject({ code: "build_input_mismatch" });
    expect(store.records.size).toBe(0);

    provider.wrongCompositionBytes = true;
    currentCandidate = input;
    await expect(cache.admit(input.value, input.input)).rejects.toMatchObject({ code: "composition_content_mismatch" });
    expect(store.records.size).toBe(0);
  });

  it("makes divergent verified outputs for the same key a permanent cache conflict", async () => {
    const { cache, store } = await setup();
    const first = await candidate();
    currentCandidate = first;
    await cache.admit(first.value, first.input);
    const second = await candidate({
      artifact: { ...first.value.statement.artifact, digest: `sha256:${"f".repeat(64)}` as typeof digestA },
    });
    currentCandidate = second;

    await expect(cache.admit(second.value, second.input)).rejects.toBeInstanceOf(BuildCacheConflictError);
    await expect(cache.lookup(first.buildKey)).resolves.toEqual({ hit: false, reason: "conflicted" });
    expect(store.records.get(first.buildKey)?.state).toBe("conflict");
  });

  it("rejects author/repository identity fields and reuses cache by immutable build key", async () => {
    const { cache, store } = await setup();
    const input = await candidate();
    currentCandidate = input;
    await cache.admit(input.value, input.input);
    const smuggledIdentity = {
      ...input.value,
      statement: { ...input.value.statement, actorId: "author", githubRepositoryId: 17 },
    };

    await expect(cache.admit(smuggledIdentity, input.input)).rejects.toMatchObject({ code: "invalid_candidate" });
    await expect(cache.lookup(input.buildKey)).resolves.toMatchObject({ hit: true });
    expect(store.records.size).toBe(1);
  });

  it("retains all artifacts referenced by running, desired, or rollback revisions", async () => {
    const { cache } = await setup();
    const input = await candidate();
    currentCandidate = input;
    const verified = await cache.admit(input.value, input.input);
    const entries = [
      { buildKey: digestA, artifact: verified, admittedAt: "2026-10-01T00:00:00.000Z", lastHitAt: null },
      { buildKey: digestB, artifact: { ...verified, buildKey: digestB, image: { ...verified.image, digest: digestB, reference: `praetorium/derived@${digestB}` } }, admittedAt: "2026-10-02T00:00:00.000Z", lastHitAt: null },
      { buildKey: digestC, artifact: { ...verified, buildKey: digestC, image: { ...verified.image, digest: digestC, reference: `praetorium/derived@${digestC}` } }, admittedAt: "2026-10-03T00:00:00.000Z", lastHitAt: null },
    ];
    const plan = planCacheGarbageCollection(entries, [
      { digest: digestA, reason: "running" },
      { digest: digestB, reason: "desired" },
      { digest: digestC, reason: "rollback" },
    ], { now: "2026-10-17T00:00:00.000Z", maxBytes: 0, maxEntries: 1, minAgeMs: 0, maxEvictions: 10 });

    expect(plan.evictedBuildKeys).toEqual([]);
    expect(plan.deletableManifestDigests).toEqual([]);
    expect(plan.entriesAfter).toBe(3);
  });
});
