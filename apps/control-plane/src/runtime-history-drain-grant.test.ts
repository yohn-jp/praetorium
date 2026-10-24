import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { OperationRecord, RepositorySnapshot } from "@praetorium/application/instances";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "@praetorium/persistence/d1";
import { applicationHostname } from "@praetorium/contracts";
import {
  createProvisionerHistoryDrainGrantRoutes,
  type LegacyDrainArtifactAllowlistEntry,
} from "./runtime-history-drain-grant.js";

const NOW = Date.parse("2026-10-25T00:00:00.000Z");
const OPERATION_ID = "op-history-drain-1";
const INSTANCE_ID = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPOSITORY_ID = 7001;
const WORKER_ID = "provisioner-1";
const CLUSTER_ID = "cluster-1";
const LEASE_TOKEN = "history-drain-lease-token-".padEnd(64, "x");
const PLATFORM_DIGEST = "sha256:2d21804e6a3686ff141afc4299259d60c245a3395d312c943a436ef25dd2e6f4";
const IMAGE_DIGEST = PLATFORM_DIGEST;
const COMPOSITION_DIGEST = `sha256:${"3".repeat(64)}`;
const PRODUCER_REVISION = "588eddcfff20fa2fc76aa8eae54c9551e0c6048b";
const GATEWAY_ORIGIN = "https://gateway.praetorium.test";
const APP_ORIGIN = `https://${applicationHostname("scriptorium", REPOSITORY_ID)}`;
const databases: DatabaseSync[] = [];

function artifactStatement(moduleVersion: string | null = "0.1.0", producerRevision = PRODUCER_REVISION): string {
  return JSON.stringify({
    schemaVersion: "praetorium.build-artifact/v1",
    buildKey: `sha256:${"4".repeat(64)}`,
    artifact: {
      repository: "registry.example/scriptorium",
      digest: IMAGE_DIGEST,
      platformManifestDigest: PLATFORM_DIGEST,
      platform: "linux/amd64",
    },
    compositionManifest: { repository: "registry.example/composition", digest: COMPOSITION_DIGEST },
    producerRevision,
    resolvedModules: moduleVersion === null
      ? []
      : [{ id: "mcp", version: moduleVersion, artifactDigest: `sha256:${"5".repeat(64)}` }],
    contractVersion: "scriptorium-build/v1",
    issuedAt: new Date(NOW).toISOString(),
  });
}

class SQLiteD1 implements D1Database {
  readonly database = new DatabaseSync(":memory:");
  artifactRow = {
    revision_status: "admitted",
    artifact_digest: IMAGE_DIGEST,
    artifact_status: "admitted",
    platform_manifest_digest: PLATFORM_DIGEST,
    composition_manifest_digest: COMPOSITION_DIGEST,
    producer_revision: PRODUCER_REVISION,
    statement_json: artifactStatement(),
  };

  constructor() {
    databases.push(this.database);
    this.database.exec(readFileSync(new URL("../migrations/0001_repository_platform.sql", import.meta.url), "utf8"));
  }

  prepare(query: string): D1PreparedStatement {
    return new SQLiteD1Statement(
      this.database,
      query,
      this.database.prepare(query),
      () => this.artifactRow,
    );
  }

  async batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    const results: D1Result<unknown>[] = [];
    for (const statement of statements) results.push(await (statement as SQLiteD1Statement).execute());
    return results as D1Result<T>[];
  }
}

class SQLiteD1Statement implements D1PreparedStatement {
  private values: readonly (string | number | null | ArrayBuffer | Uint8Array)[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly statement: StatementSync,
    private readonly artifactRow: () => unknown,
  ) {}

  bind(...values: readonly (string | number | null | ArrayBuffer | Uint8Array)[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  private valuesForSql(): SQLInputValue[] {
    return this.values.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM operations"))
      return { actor_id: "12345", authorization_revision: 9 } as T;
    if (this.query.includes("FROM deployment_revisions")) return this.artifactRow() as T;
    return (this.statement.get(...this.valuesForSql()) as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return { results: this.statement.all(...this.valuesForSql()) as T[], meta: { changes: 0 } };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const result = this.statement.run(...this.valuesForSql());
    return { results: [], meta: { changes: Number(result.changes) } };
  }

  async execute(): Promise<D1Result> {
    if (/^\s*(SELECT|WITH)\b/iu.test(this.query))
      return { results: this.statement.all(...this.valuesForSql()), meta: { changes: 0 } };
    const result = this.statement.run(...this.valuesForSql());
    return { results: [], meta: { changes: Number(result.changes) } };
  }
}

function census(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    complete: true,
    providerObservationId: "pod-list-rv-900",
    observedAt: new Date(NOW - 500).toISOString(),
    matchedWriterCount: 1,
    writers: [{ runtimeEpoch: 4, phase: "running", identities: ["pod-uid-old-1"] }],
    ...overrides,
  };
}

function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  const lifecycle = {
    id: OPERATION_ID,
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    generation: 8,
    runtimeEpoch: 5,
    kind: "update",
    phase: "stopping-old",
    clusterId: CLUSTER_ID,
    current: {
      instanceId: INSTANCE_ID,
      repositoryId: REPOSITORY_ID,
      generation: 7,
      runtimeEpoch: 4,
      clusterId: CLUSTER_ID,
      reservationId: "res-old-4",
      deployment: {
        revisionId: "revision-old-7",
        repositoryId: REPOSITORY_ID,
        imageDigest: IMAGE_DIGEST,
        platformManifestDigest: PLATFORM_DIGEST,
        compositionManifestDigest: COMPOSITION_DIGEST,
        enabledModuleIds: ["mcp"],
        runtimeMetadata: { producerRevision: PRODUCER_REVISION },
      },
    },
    target: null,
    targetEpoch: null,
    rollbackEpoch: null,
    rollbackCompatibilityEvidence: null,
    rollbackCompatible: null,
    writerAbsenceProof: null,
    quiesceRequest: {
      contractVersion: "scriptorium-platform/v1",
      operationId: OPERATION_ID,
      instanceId: INSTANCE_ID,
      runtimeEpoch: 4,
      reason: "update",
      deadline: new Date(NOW + 10_000).toISOString(),
    },
    quiesceReceipt: {
      contractVersion: "scriptorium-platform/v1",
      operationId: OPERATION_ID,
      instanceId: INSTANCE_ID,
      runtimeEpoch: 4,
      quiesceRevision: "quiesce-rv-10",
      disposition: "safe",
      activeMutations: 0,
      activeJobs: 0,
      restartableJobs: 0,
      pendingCheckpoints: 0,
      uncertainPublication: false,
      lastConfirmedRemoteRevision: null,
      reasonCodes: [],
      observedAt: new Date(NOW - 5_000).toISOString(),
    },
  };
  return {
    id: OPERATION_ID,
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    generation: 8,
    runtimeEpoch: 5,
    kind: "update",
    status: "running",
    attempt: 1,
    leaseEpoch: 4,
    reportSequence: 0,
    leaseExpiresAt: NOW + 30_000,
    clusterId: CLUSTER_ID,
    reservationId: "res-new-5",
    deploymentRevisionId: "revision-new-8",
    buildId: null,
    prerequisiteBuildId: null,
    idempotencyKey: "request-8",
    phase: "stopping-old",
    workerId: WORKER_ID,
    leaseToken: LEASE_TOKEN,
    requestHash: "hash-8",
    checkpointSequence: 11,
    checkpoint: { schemaVersion: 1, lifecycle, writerAbsenceProof: null },
    result: null,
    createdAt: NOW - 1_000,
    updatedAt: NOW,
    ...overrides,
  };
}

function stopOperation(options: {
  readonly oldGeneration?: number;
  readonly oldEpoch?: number;
  readonly desiredGeneration?: number;
  readonly desiredEpoch?: number;
  readonly desiredRevisionId?: string;
} = {}): OperationRecord {
  const oldGeneration = options.oldGeneration ?? 7;
  const oldEpoch = options.oldEpoch ?? 4;
  const desiredGeneration = options.desiredGeneration ?? 8;
  const desiredEpoch = options.desiredEpoch ?? 4;
  const desiredRevisionId = options.desiredRevisionId ?? "revision-old-7";
  const base = operation();
  const checkpoint = base.checkpoint as Record<string, unknown>;
  const lifecycle = checkpoint["lifecycle"] as Record<string, unknown>;
  const current = lifecycle["current"] as Record<string, unknown>;
  const request = lifecycle["quiesceRequest"] as Record<string, unknown>;
  const receipt = lifecycle["quiesceReceipt"] as Record<string, unknown>;
  return operation({
    generation: desiredGeneration,
    runtimeEpoch: desiredEpoch,
    kind: "stop",
    deploymentRevisionId: desiredRevisionId,
    reservationId: null,
    checkpoint: {
      schemaVersion: 1,
      writerAbsenceProof: null,
      lifecycle: {
        ...lifecycle,
        generation: desiredGeneration,
        runtimeEpoch: desiredEpoch,
        kind: "stop",
        reason: "user",
        current: { ...current, generation: oldGeneration, runtimeEpoch: oldEpoch },
        target: null,
        targetEpoch: null,
        targetReservationId: null,
        quiesceRequest: { ...request, runtimeEpoch: oldEpoch, reason: "stop" },
        quiesceReceipt: { ...receipt, runtimeEpoch: oldEpoch },
      },
    },
  });
}

function snapshot(overrides: {
  readonly suspended?: boolean;
  readonly authorizationRevision?: number;
  readonly desiredState?: "running" | "stopped";
  readonly generation?: number;
  readonly runtimeEpoch?: number;
  readonly desiredRevisionId?: string | null;
  readonly observedState?: RepositorySnapshot["instance"]["observedState"];
  readonly observedGeneration?: number | null;
  readonly observedEpoch?: number | null;
} = {}): RepositorySnapshot {
  return {
    binding: {
      repositoryId: REPOSITORY_ID,
      installationId: 9001,
      owner: "owner",
      name: "repo",
      instanceId: INSTANCE_ID,
      authorizationRevision: overrides.authorizationRevision ?? 9,
      bindingEpoch: 2,
      suspended: overrides.suspended ?? false,
    },
    instance: {
      instanceId: INSTANCE_ID,
      repositoryId: REPOSITORY_ID,
      generation: overrides.generation ?? 8,
      runtimeEpoch: overrides.runtimeEpoch ?? 5,
      desiredState: overrides.desiredState ?? "running",
      policy: "stable",
      observedGeneration: overrides.observedGeneration === undefined ? 7 : overrides.observedGeneration,
      observedRuntimeEpoch: overrides.observedEpoch === undefined ? 4 : overrides.observedEpoch,
      observedSequence: 6,
      observedState: overrides.observedState ?? "ready",
      desiredRevisionId: overrides.desiredRevisionId === undefined
        ? "revision-new-8"
        : overrides.desiredRevisionId,
      observedRevisionId: "revision-old-7",
      currentArtifactDigest: IMAGE_DIGEST,
      desiredArtifactDigest: `sha256:${"3".repeat(64)}`,
      reservationState: "reserved",
      reservationId: "res-new-5",
      clusterId: CLUSTER_ID,
      createdAt: NOW - 100_000,
      updatedAt: NOW,
    },
  };
}

function request(body: Record<string, unknown>): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function harness(options: {
  readonly op?: OperationRecord;
  readonly snap?: RepositorySnapshot;
  readonly gatewayResponse?: Record<string, unknown>;
  readonly gatewayAction?: (operation: OperationRecord) => void;
  readonly artifacts?: readonly LegacyDrainArtifactAllowlistEntry[];
  readonly artifactRow?: Partial<SQLiteD1["artifactRow"]>;
} = {}) {
  const db = new SQLiteD1();
  db.artifactRow = { ...db.artifactRow, ...options.artifactRow };
  let currentOperation = options.op ?? operation();
  let currentSnapshot = options.snap ?? snapshot();
  let gatewayCalls = 0;
  let gatewayInput: unknown = null;
  const grantResponse = options.gatewayResponse ?? {
    issuer: GATEWAY_ORIGIN,
    jwksUrl: `${GATEWAY_ORIGIN}/.well-known/jwks.json`,
    origin: APP_ORIGIN,
    audience: APP_ORIGIN,
    authorizationRevision: 9,
    grant: "signedAccessGrantCookieValue-0123456789",
    permissions: ["read"],
  };
  const app = createProvisionerHistoryDrainGrantRoutes({
    db,
    operations: {
      async getById(id: string) { return id === OPERATION_ID ? currentOperation : null; },
    },
    instances: {
      async getByInstanceId(id: string) { return id === INSTANCE_ID ? currentSnapshot : null; },
    },
    gateway: {
      async fetch(req: Request) {
        gatewayCalls += 1;
        gatewayInput = await req.json();
        options.gatewayAction?.(currentOperation);
        return Response.json(grantResponse);
      },
    },
    gatewaySecret: "gateway-secret-test-value-0123456789",
    gatewayOrigin: GATEWAY_ORIGIN,
    workerId: WORKER_ID,
    clusterId: CLUSTER_ID,
    legacyDrainArtifacts: options.artifacts ?? [{
      platformManifestDigest: PLATFORM_DIGEST,
      producerRevision: PRODUCER_REVISION,
      enabledModuleIds: ["mcp"],
    }],
    now: () => NOW,
  });
  return {
    app,
    db,
    get gatewayCalls() { return gatewayCalls; },
    get gatewayInput() { return gatewayInput; },
    setOperation(value: OperationRecord) { currentOperation = value; },
    setSnapshot(value: RepositorySnapshot) { currentSnapshot = value; },
  };
}

const BASE_BODY = {
  workerId: WORKER_ID,
  leaseToken: LEASE_TOKEN,
  leaseEpoch: 4,
  expectedCheckpointSequence: 11,
  census: census(),
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("provisioner history drain grant", () => {
  it("derives the exact old tuple from checkpoint and returns only the read grant", async () => {
    const h = await harness();
    const response = await h.app.request(`/operations/${OPERATION_ID}/history-drain-grant`, request(BASE_BODY));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      issuer: GATEWAY_ORIGIN,
      jwksUrl: `${GATEWAY_ORIGIN}/.well-known/jwks.json`,
      origin: APP_ORIGIN,
      audience: APP_ORIGIN,
      authorizationRevision: 9,
      grant: "signedAccessGrantCookieValue-0123456789",
      permissions: ["read"],
    });
    expect(h.gatewayInput).toEqual({
      operationId: OPERATION_ID,
      actorId: "12345",
      repositoryId: REPOSITORY_ID,
      instanceId: INSTANCE_ID,
      authorizationRevision: 9,
      oldGeneration: 7,
      oldRuntimeEpoch: 4,
      currentGeneration: 8,
      currentRuntimeEpoch: 5,
    });
    expect(h.db.database.prepare(
      "SELECT actor_id, action, outcome FROM audit_events",
    ).all()).toEqual([{
      actor_id: "12345",
      action: "runtime.history-drain-census-admitted",
      outcome: "recorded",
    }]);
  });

  it("accepts a canonical desired-stopped operation draining its unchanged observed epoch", async () => {
    const h = await harness({
      op: stopOperation(),
      snap: snapshot({
        desiredState: "stopped",
        runtimeEpoch: 4,
        desiredRevisionId: "revision-old-7",
      }),
    });
    const response = await h.app.request(`/operations/${OPERATION_ID}/history-drain-grant`, request(BASE_BODY));
    expect(response.status).toBe(200);
    expect(h.gatewayInput).toMatchObject({
      oldGeneration: 7,
      oldRuntimeEpoch: 4,
      currentGeneration: 8,
      currentRuntimeEpoch: 4,
    });
  });

  it("drains a retained old writer when desired generation and epoch already advanced", async () => {
    const h = await harness({
      op: stopOperation({
        oldGeneration: 1,
        oldEpoch: 1,
        desiredGeneration: 5,
        desiredEpoch: 2,
        desiredRevisionId: "revision-failed-target-4",
      }),
      snap: snapshot({
        desiredState: "stopped",
        generation: 5,
        runtimeEpoch: 2,
        desiredRevisionId: "revision-failed-target-4",
        observedGeneration: 1,
        observedEpoch: 1,
      }),
    });
    const body = {
      ...BASE_BODY,
      census: census({ writers: [{ runtimeEpoch: 1, phase: "running", identities: ["pod-retained-old"] }] }),
    };
    const response = await h.app.request(`/operations/${OPERATION_ID}/history-drain-grant`, request(body));
    expect(response.status).toBe(200);
    expect(h.gatewayInput).toMatchObject({
      oldGeneration: 1,
      oldRuntimeEpoch: 1,
      currentGeneration: 5,
      currentRuntimeEpoch: 2,
    });
  });

  it.each([
    ["stale lease", { op: operation({ leaseExpiresAt: NOW }) }, BASE_BODY],
    ["wrong checkpoint sequence", {}, { ...BASE_BODY, expectedCheckpointSequence: 10 }],
    ["writer absence proof", { op: operation({ checkpoint: {
      schemaVersion: 1,
      lifecycle: { ...operation().checkpoint!.lifecycle as object, writerAbsenceProof: { remainingWriters: 0 } },
      writerAbsenceProof: { remainingWriters: 0 },
    } }) }, BASE_BODY],
    ["rollback epoch", { op: operation({ checkpoint: {
      schemaVersion: 1,
      lifecycle: { ...operation().checkpoint!.lifecycle as object, rollbackEpoch: 9 },
    } }) }, BASE_BODY],
    ["suspended binding", { snap: snapshot({ suspended: true }) }, BASE_BODY],
    ["old writer no longer ready", { snap: snapshot({ observedState: "stopped" }) }, BASE_BODY],
    ["old epoch mismatch", { snap: snapshot({ observedEpoch: 3 }) }, BASE_BODY],
    ["stop with running desired state", {
      op: stopOperation(),
      snap: snapshot({ runtimeEpoch: 4 }),
    }, BASE_BODY],
    ["stop with a replacement epoch", {
      op: stopOperation(),
      snap: snapshot({ desiredState: "stopped", runtimeEpoch: 5 }),
    }, BASE_BODY],
    ["stale authorization revision", { snap: snapshot({ authorizationRevision: 8 }) }, BASE_BODY],
    ["unsafe quiesce receipt", { op: operation({ checkpoint: {
      ...operation().checkpoint!,
      lifecycle: {
        ...operation().checkpoint!.lifecycle as object,
        quiesceReceipt: {
          ...((operation().checkpoint!.lifecycle as Record<string, unknown>).quiesceReceipt as object),
          activeJobs: 1,
        },
      },
    } }) }, BASE_BODY],
    ["legacy tuple not allowlisted", { artifacts: [] }, BASE_BODY],
    ["artifact producer differs from admitted proof", { artifactRow: { producer_revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }, BASE_BODY],
    ["artifact has another module version", { artifactRow: { statement_json: artifactStatement("0.2.0") } }, BASE_BODY],
    ["incomplete census", {}, { ...BASE_BODY, census: census({ complete: false }) }],
    ["multiple writers", {}, { ...BASE_BODY, census: census({
      matchedWriterCount: 2,
      writers: [
        { runtimeEpoch: 4, phase: "running", identities: ["pod-old"] },
        { runtimeEpoch: 5, phase: "running", identities: ["pod-new"] },
      ],
    }) }],
    ["terminating old writer", {}, { ...BASE_BODY, census: census({
      writers: [{ runtimeEpoch: 4, phase: "terminating", identities: ["pod-old"] }],
    }) }],
    ["stale census", {}, { ...BASE_BODY, census: census({ observedAt: new Date(NOW - 30_001).toISOString() }) }],
    ["spoofed actor", {}, { ...BASE_BODY, actorId: "99999" }],
  ] as const)("rejects %s without issuing a Gateway grant", async (_label, options, body) => {
    const h = await harness(options);
    const response = await h.app.request(`/operations/${OPERATION_ID}/history-drain-grant`, request(body));
    expect([400, 409]).toContain(response.status);
    expect(h.gatewayCalls).toBe(0);
  });

  it("rejects a Gateway response with write authority", async () => {
    const h = await harness({ gatewayResponse: {
      issuer: GATEWAY_ORIGIN,
      jwksUrl: `${GATEWAY_ORIGIN}/.well-known/jwks.json`,
      origin: APP_ORIGIN,
      audience: APP_ORIGIN,
      authorizationRevision: 9,
      grant: "signedAccessGrantCookieValue-0123456789",
      permissions: ["read", "write"],
    } });
    const response = await h.app.request(`/operations/${OPERATION_ID}/history-drain-grant`, request(BASE_BODY));
    expect(response.status).toBe(503);
  });

  it("rechecks the lease and checkpoint after the Gateway call before returning a grant", async () => {
    let mutateAfterGateway = () => {};
    const h = await harness({ gatewayAction: () => {
      mutateAfterGateway();
    } });
    mutateAfterGateway = () => {
      h.setOperation(operation({ phase: "complete" }));
    };
    const response = await h.app.request(`/operations/${OPERATION_ID}/history-drain-grant`, request(BASE_BODY));
    expect(response.status).toBe(409);
    expect(h.gatewayCalls).toBe(1);
  });

  it("accepts the separately allowlisted legacy core-only artifact with no modules", async () => {
    const coreProducer = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const base = operation();
    const checkpoint = base.checkpoint as Record<string, unknown>;
    const lifecycle = checkpoint["lifecycle"] as Record<string, unknown>;
    const current = lifecycle["current"] as Record<string, unknown>;
    const deployment = current["deployment"] as Record<string, unknown>;
    const coreOperation = operation({ checkpoint: {
      ...checkpoint,
      lifecycle: {
        ...lifecycle,
        current: {
          ...current,
          deployment: {
            ...deployment,
            enabledModuleIds: [],
            runtimeMetadata: { producerRevision: coreProducer },
          },
        },
      },
    } });
    const h = await harness({
      op: coreOperation,
      artifacts: [{
        platformManifestDigest: PLATFORM_DIGEST,
        producerRevision: coreProducer,
        enabledModuleIds: [],
      }],
      artifactRow: {
        producer_revision: coreProducer,
        statement_json: artifactStatement(null, coreProducer),
      },
    });
    const response = await h.app.request(`/operations/${OPERATION_ID}/history-drain-grant`, request(BASE_BODY));
    expect(response.status).toBe(200);
  });
});
