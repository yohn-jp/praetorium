import { describe, expect, it, vi } from "vitest";
import type { D1Database } from "@praetorium/persistence/d1";
import {
  createReleaseCanaryObservationReader,
  type RuntimeHealthObservationRow,
} from "./release-canary-observations.js";

const now = Date.parse("2026-10-17T05:00:00.000Z");
const instanceId = "ins_01K7KJ3N5H8C0X2V6T4Q9M1PAB";
const repositoryId = 73_001;
const runtimeEpoch = 12;
const generation = 8;
const clusterId = "owned-canary-cluster";
const operationId = "op-canary-start";
const revisionId = "revision-canary-8";
const artifactDigest = `sha256:${"a".repeat(64)}`;
const actualImageDigest = `sha256:${"b".repeat(64)}`;
const compositionManifestDigest = `sha256:${"c".repeat(64)}`;

function checkpointEvidence() {
  const assignment = {
    instanceId,
    repositoryId,
    generation,
    runtimeEpoch,
    clusterId,
    deployment: {
      revisionId,
      imageDigest: artifactDigest,
      platformManifestDigest: actualImageDigest,
      compositionManifestDigest,
      enabledModuleIds: ["core", "semantic"],
    },
  };
  return {
    assignment,
    providerObservationId: "startup-provider-observation",
    actualImageDigest,
    compositionManifestDigest,
    enabledModuleIds: ["semantic", "core"],
    applicationProbeId: "startup-application-probe",
    validGrantProbeId: "startup-valid-grant-probe",
    wrongRepositoryProbeId: "startup-wrong-repository-probe",
    wrongEpochProbeId: "startup-wrong-epoch-probe",
    invalidServiceCredentialProbeId: "startup-invalid-service-credential-probe",
    uiApiMcpProbeId: "startup-ui-api-mcp-probe",
    persistenceProbeId: "startup-persistence-probe",
    persistence: {
      state: "verified",
      observedRemoteCommit: "d".repeat(40),
      formats: [{ formatId: "scriptorium-work", version: 1 }],
    },
    producerObservedAt: new Date(now - 2_000).toISOString(),
    verifiedAt: new Date(now - 1_000).toISOString(),
  };
}

function startOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: operationId,
    instanceId,
    repositoryId,
    generation,
    runtimeEpoch,
    clusterId,
    deploymentRevisionId: revisionId,
    kind: "start",
    status: "succeeded",
    createdAt: now - 5_000,
    checkpoint: {
      schemaVersion: 1,
      lifecycle: {
        phase: "complete",
        readinessEvidence: checkpointEvidence(),
      },
    },
    result: {
      terminal: "succeeded",
      observation: {
        instanceId,
        repositoryId,
        generation,
        runtimeEpoch,
        observedState: "ready",
        observedRevisionId: revisionId,
        observedArtifactDigest: artifactDigest,
      },
    },
    ...overrides,
  };
}

function sampleEvidence(overrides: Record<string, unknown> = {}) {
  const base = {
    assignment: {
      instanceId,
      repositoryId,
      generation,
      runtimeEpoch,
      clusterId,
      deployment: {
        revisionId,
        imageDigest: artifactDigest,
        platformManifestDigest: actualImageDigest,
        compositionManifestDigest,
      },
    },
    providerObservationId: "provider-observation-sample-13",
    actualImageDigest,
    compositionManifestDigest,
    enabledModuleIds: ["core", "semantic"],
    applicationProbeId: "sample-application-probe",
    validGrantProbeId: "sample-valid-grant-probe",
    wrongRepositoryProbeId: "sample-wrong-repository-probe",
    wrongEpochProbeId: "sample-wrong-epoch-probe",
    invalidServiceCredentialProbeId: "sample-invalid-service-credential-probe",
    uiApiMcpProbeId: "sample-ui-api-mcp-probe",
    persistenceProbeId: "sample-persistence-probe",
    persistence: {
      state: "verified",
      observedRemoteCommit: "e".repeat(40),
      formats: [{ formatId: "scriptorium-work", version: 1 }],
    },
    producerObservedAt: new Date(now - 2_000).toISOString(),
    verifiedAt: new Date(now - 1_000).toISOString(),
  };
  return { ...base, ...overrides };
}

function healthRow(evidence: unknown = sampleEvidence(), overrides: Partial<RuntimeHealthObservationRow> = {}) {
  return {
    instance_id: instanceId,
    repository_id: repositoryId,
    runtime_epoch: runtimeEpoch,
    generation,
    cluster_id: clusterId,
    operation_id: operationId,
    provider_observation_id: "provider-observation-sample-13",
    observed_at: now - 1_000,
    evidence_json: JSON.stringify(evidence),
    ...overrides,
  } satisfies RuntimeHealthObservationRow;
}

function database(row: RuntimeHealthObservationRow | null): D1Database {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => row),
    all: vi.fn(),
    run: vi.fn(),
  };
  return {
    prepare: vi.fn(() => statement),
    batch: vi.fn(),
  } as unknown as D1Database;
}

describe("T11 persisted canary observations", () => {
  it("uses a fresh authenticated D1 sample bound to the succeeded canary operation", async () => {
    const operation = startOperation();
    const operations = { getById: vi.fn(async () => operation) };
    const db = database(healthRow());
    const reader = createReleaseCanaryObservationReader(operations, db, () => now);

    await expect(
      reader.latestHealth({ instanceId, repositoryId, operationId: operation.id }),
    ).resolves.toEqual({
      artifactDigest,
      runtimeId: instanceId,
      operationId: operation.id,
      runtimeEpoch,
      providerObservationId: "provider-observation-sample-13",
      source: "runtime-provisioner-observation",
      imageIdentityVerified: true,
      observedAt: now - 1_000,
      checks: { startup: true, auth: true, uiApiMcp: true, persistence: true },
      checkEvidence: {
        startup: "sample-application-probe",
        auth: "sample-valid-grant-probe;sample-wrong-repository-probe;sample-wrong-epoch-probe;sample-invalid-service-credential-probe",
        uiApiMcp: "sample-ui-api-mcp-probe",
        persistence: "sample-persistence-probe",
      },
    });
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("FROM runtime_health_observations"));
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("WHERE instance_id = ? AND repository_id = ?"));
  });

  it("keeps absent, stale, cross-epoch, cross-operation, and incomplete samples unknown", async () => {
    const operation = startOperation();
    const missingProbe = sampleEvidence({ uiApiMcpProbeId: undefined });
    const staleEvidence = sampleEvidence({
      verifiedAt: new Date(now - 31_000).toISOString(),
    });
    const cases: Array<{ readonly row: RuntimeHealthObservationRow | null; readonly operation: unknown }> = [
      { row: null, operation },
      { row: healthRow(sampleEvidence(), { runtime_epoch: runtimeEpoch + 1 }), operation },
      { row: healthRow(sampleEvidence(), { operation_id: "op-other" }), operation },
      { row: healthRow(missingProbe), operation },
      { row: healthRow(staleEvidence), operation },
      { row: healthRow(sampleEvidence(), { provider_observation_id: "other-provider-observation" }), operation },
      { row: healthRow(), operation: { ...operation, status: "failed" } },
    ];

    for (const { row, operation: caseOperation } of cases) {
      const caseReader = createReleaseCanaryObservationReader(
        { getById: vi.fn(async () => caseOperation) },
        database(row),
        () => now,
      );
      await expect(
        caseReader.latestHealth({ instanceId, repositoryId, operationId }),
      ).resolves.toBeNull();
    }
  });

  it("returns writer absence only from a fresh successful stop checkpoint with a provider zero-writer census", async () => {
    const censusObservedAt = new Date(now - 1_000).toISOString();
    const stopOperation = {
      id: "op-canary-stop",
      instanceId,
      repositoryId,
      kind: "stop",
      status: "succeeded",
      runtimeEpoch,
      createdAt: now - 4_000,
      checkpoint: {
        schemaVersion: 1,
        writerAbsenceProof: {
          instanceId,
          repositoryId,
          retiredRuntimeEpoch: runtimeEpoch,
          providerObservationId: "provider-census-12",
          censusObservedAt,
          remainingWriters: 0,
          evidenceIdentities: ["pod-uid-12"],
          source: "runtime-provider-census",
        },
      },
      result: { terminal: "succeeded" },
    };
    const reader = createReleaseCanaryObservationReader(
      { getById: async () => stopOperation },
      database(null),
      () => now,
    );

    await expect(
      reader.writerAbsence({
        instanceId,
        repositoryId,
        retiredEpoch: runtimeEpoch,
        afterOperationId: stopOperation.id,
      }),
    ).resolves.toEqual({
      instanceId,
      repositoryId,
      retiredEpoch: runtimeEpoch,
      providerObservationId: "provider-census-12",
      censusObservedAt: now - 1_000,
      remainingWriters: 0,
      evidenceIdentities: ["pod-uid-12"],
      source: "runtime-provider-census",
    });

    const noCensus = createReleaseCanaryObservationReader(
      { getById: async () => ({ ...stopOperation, checkpoint: { schemaVersion: 1 } }) },
      database(null),
      () => now,
    );
    await expect(
      noCensus.writerAbsence({
        instanceId,
        repositoryId,
        retiredEpoch: runtimeEpoch,
        afterOperationId: stopOperation.id,
      }),
    ).resolves.toBeNull();
  });
});
