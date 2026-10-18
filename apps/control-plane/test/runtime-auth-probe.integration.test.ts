import { describe, expect, it } from "vitest";
import { verifyAccessGrant, type SigningKey } from "@praetorium/auth";
import { instanceHostname } from "@praetorium/contracts";
import type { OperationRecord, RepositorySnapshot } from "@praetorium/application/instances";
import type { D1Database, D1PreparedStatement, D1Result } from "@praetorium/persistence/d1";
import type { RuntimeBindingMetadata } from "../src/runtime-binding.js";
import type { GatewayContext } from "../../gateway/src/context.js";
import { createRuntimeAuthProbeRoutes } from "../../gateway/src/runtime-auth-probes.js";
import { createProvisionerRuntimeAuthProbeRoutes } from "../src/runtime-auth-probe.js";

const NOW = "2026-10-17T00:00:10.000Z";
const NOW_MS = Date.parse(NOW);
const INSTANCE_ID = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPOSITORY_ID = 7001;
const INSTALLATION_ID = 9001;
const OPERATION_ID = "op-auth-probe-1";
const WORKER_ID = "provisioner-1";
const CLUSTER_ID = "cluster-1";
const LEASE_TOKEN = "lease-secret-".padEnd(64, "x");
const GENERATION = 7;
const RUNTIME_EPOCH = 12;
const REVISION_ID = "revision-12";
const INDEX_DIGEST = `sha256:${"1".repeat(64)}`;
const PLATFORM_DIGEST = `sha256:${"2".repeat(64)}`;
const COMPOSITION_DIGEST = `sha256:${"3".repeat(64)}`;
const GATEWAY_ORIGIN = "https://gateway.praetorium.test";
const CONTROL_PLANE_ORIGIN = "https://control.praetorium.test";
const INSTANCE_SUFFIX = "hosted.praetorium.test";
const INSTANCE_ORIGIN = `https://${instanceHostname(INSTANCE_ID, INSTANCE_SUFFIX)}`;
const GATEWAY_SECRET = "control-plane-gateway-auth-secret".padEnd(40, "x");

interface ProbeStatement extends D1PreparedStatement {
  query: string;
  values: readonly (string | number | null | ArrayBuffer | Uint8Array)[];
}

class ProbeDatabase implements D1Database {
  constructor(
    private readonly statementJson: string,
    private readonly actorId = "12345",
    private readonly auditActors: readonly { readonly actor_id: string }[] = [],
  ) {}

  prepare(query: string): D1PreparedStatement {
    const statementJson = this.statementJson;
    const actorId = this.actorId;
    const auditActors = this.auditActors;
    const statement: ProbeStatement = {
      query,
      values: [],
      bind(...values) {
        statement.values = values;
        return statement;
      },
      async first<T = unknown>(): Promise<T | null> {
        if (query.includes("FROM operations")) {
          return { actor_id: actorId, authorization_revision: 4 } as T;
        }
        if (query.includes("FROM deployment_revisions")) {
          const statement = JSON.parse(statementJson) as { artifact: { digest: string } };
          return { status: "admitted", artifact_digest: statement.artifact.digest, statement_json: statementJson } as T;
        }
        return null;
      },
      async all<T = unknown>(): Promise<D1Result<T>> {
        const results = query.includes("FROM audit_events") ? auditActors : [];
        return { results: results as T[], meta: { changes: 0 } };
      },
      async run<T = unknown>(): Promise<D1Result<T>> {
        return { results: [], meta: { changes: 0 } };
      },
    };
    return statement;
  }

  async batch<T = unknown>(): Promise<readonly D1Result<T>[]> {
    return [];
  }
}

function artifactStatement(
  digest = INDEX_DIGEST,
  platformManifestDigest = PLATFORM_DIGEST,
  compositionManifestDigest = COMPOSITION_DIGEST,
): string {
  return JSON.stringify({
    schemaVersion: "praetorium.build-artifact/v1",
    buildKey: `sha256:${"4".repeat(64)}`,
    artifact: {
      repository: "registry.praetorium.test/scriptorium",
      digest,
      platformManifestDigest,
      platform: "linux/amd64",
    },
    compositionManifest: {
      repository: "registry.praetorium.test/compositions/hosted",
      digest: compositionManifestDigest,
    },
    producerRevision: "a".repeat(40),
    resolvedModules: [],
    contractVersion: "scriptorium-build/v1",
    issuedAt: NOW,
  });
}

function operation(): OperationRecord {
  return {
    id: OPERATION_ID,
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    generation: GENERATION,
    runtimeEpoch: RUNTIME_EPOCH,
    kind: "start",
    status: "running",
    attempt: 1,
    leaseEpoch: 3,
    reportSequence: 1,
    leaseExpiresAt: NOW_MS + 30_000,
    clusterId: CLUSTER_ID,
    reservationId: "reservation-12",
    deploymentRevisionId: REVISION_ID,
    buildId: "build-12",
    prerequisiteBuildId: null,
    idempotencyKey: "request-12",
    phase: "starting-target",
    workerId: WORKER_ID,
    leaseToken: LEASE_TOKEN,
    requestHash: "request-hash",
    checkpointSequence: 1,
    checkpoint: null,
    result: null,
    createdAt: NOW_MS - 1_000,
    updatedAt: NOW_MS,
  };
}

function assignment() {
  return {
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    generation: GENERATION,
    runtimeEpoch: RUNTIME_EPOCH,
    clusterId: CLUSTER_ID,
    revisionId: REVISION_ID,
    imageDigest: INDEX_DIGEST,
    platformManifestDigest: PLATFORM_DIGEST,
    compositionManifestDigest: COMPOSITION_DIGEST,
    enabledModuleIds: [],
    grantPolicy: {
      issuer: GATEWAY_ORIGIN,
      jwksUrl: `${GATEWAY_ORIGIN}/.well-known/jwks.json`,
      audience: INSTANCE_ORIGIN,
    },
    controlServicePolicy: {
      issuer: CONTROL_PLANE_ORIGIN,
      jwksUrl: `${CONTROL_PLANE_ORIGIN}/.well-known/control-jwks.json`,
      audience: "praetorium-runtime-control",
    },
  } as const;
}

function repositorySnapshot(
  runtimeEpoch = RUNTIME_EPOCH,
  generation = GENERATION,
  instanceOverrides: Partial<RepositorySnapshot["instance"]> = {},
): RepositorySnapshot {
  return {
    binding: {
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
      owner: "owner",
      name: "book",
      instanceId: INSTANCE_ID,
      authorizationRevision: 4,
      bindingEpoch: 2,
      suspended: false,
      createdAt: NOW_MS - 10_000,
      updatedAt: NOW_MS,
    },
    instance: {
      instanceId: INSTANCE_ID,
      repositoryId: REPOSITORY_ID,
      generation,
      runtimeEpoch,
      desiredState: "running",
      observedGeneration: generation,
      observedRuntimeEpoch: runtimeEpoch,
      observedSequence: 1,
      observedState: "ready",
      desiredRevisionId: REVISION_ID,
      observedRevisionId: REVISION_ID,
      currentArtifactDigest: INDEX_DIGEST,
      desiredArtifactDigest: INDEX_DIGEST,
      reservationState: "allocated",
      reservationId: "reservation-12",
      clusterId: CLUSTER_ID,
      createdAt: NOW_MS - 10_000,
      updatedAt: NOW_MS,
      ...instanceOverrides,
    },
  };
}

async function makeHarness(
  accessAllowed = true,
  operationRecord: OperationRecord = operation(),
  statementJson = artifactStatement(),
  actorId = "12345",
  auditActors: readonly { readonly actor_id: string }[] = [],
  options: {
    readonly instance?: Partial<RepositorySnapshot["instance"]>;
    readonly runtimeBinding?: RuntimeBindingMetadata | null;
  } = {},
) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const signingKey: SigningKey = { kid: "gateway-probe-test", privateKey: pair.privateKey };
  const snapshot = repositorySnapshot(
    operationRecord.runtimeEpoch,
    operationRecord.generation,
    options.instance,
  );
  const authorizedActors: string[] = [];
  const gatewayContext = {
    config: {
      origin: GATEWAY_ORIGIN,
      controlPlaneSecret: GATEWAY_SECRET,
      instanceHostnameSuffix: INSTANCE_SUFFIX,
      accessGrantTtlSeconds: 60,
    },
    requestNow: NOW,
    controlPlane: {
      async getByRepositoryId(repositoryId: number) {
        return repositoryId === REPOSITORY_ID ? snapshot : null;
      },
    },
    githubAccess: {
      async authorize(actorId: string, repositoryId: number) {
        authorizedActors.push(actorId);
        return {
          allowed: accessAllowed,
          permissions: accessAllowed ? ["read"] : [],
          checkedAt: NOW_MS,
          expiresAt: NOW_MS + 60_000,
          installationId: INSTALLATION_ID,
          repositoryId,
        };
      },
    },
    getSigningKey: async () => signingKey,
  } as unknown as GatewayContext;
  const gateway = createRuntimeAuthProbeRoutes(gatewayContext);
  const db = new ProbeDatabase(statementJson, actorId, auditActors);
  const operations = { async getById(id: string) { return id === OPERATION_ID ? operationRecord : null; } };
  const instances = { async getByInstanceId(id: string) { return id === INSTANCE_ID ? snapshot : null; } };
  const controlPlane = createProvisionerRuntimeAuthProbeRoutes({
    db,
    operations: operations as never,
    instances: instances as never,
    runtimeBindings: {
      async getCurrent(repositoryId: number) {
        return repositoryId === REPOSITORY_ID ? options.runtimeBinding ?? null : null;
      },
    },
    gateway: { fetch: (request) => gateway.fetch(request) },
    gatewaySecret: GATEWAY_SECRET,
    gatewayOrigin: GATEWAY_ORIGIN,
    controlPlaneOrigin: CONTROL_PLANE_ORIGIN,
    instanceHostSuffix: INSTANCE_SUFFIX,
    workerId: WORKER_ID,
    clusterId: CLUSTER_ID,
    now: () => NOW_MS,
  });
  return { gateway, controlPlane, pair, authorizedActors };
}

describe("Control Plane to Gateway runtime auth probe", () => {
  it("uses the active post-absence target reservation to verify the cluster before the first ready observation", async () => {
    const { controlPlane } = await makeHarness(
      true,
      operation(),
      artifactStatement(),
      "12345",
      [],
      {
        instance: {
          observedState: "absent",
          observedRuntimeEpoch: null,
          clusterId: null,
          reservationState: "reserved",
        },
        runtimeBinding: {
          repositoryId: REPOSITORY_ID,
          installationId: INSTALLATION_ID,
          instanceId: INSTANCE_ID,
          runtimeId: "reservation-12",
          runtimeEpoch: RUNTIME_EPOCH,
          leaseId: "reservation-12",
          clusterId: CLUSTER_ID,
          active: true,
          authority: "post-absence-target",
        },
      },
    );

    const response = await controlPlane.request(`/operations/${OPERATION_ID}/auth-probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "lease",
        workerId: WORKER_ID,
        leaseToken: LEASE_TOKEN,
        leaseEpoch: 3,
        assignment: assignment(),
      }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
  });

  it.each([
    {
      name: "a different cluster",
      runtimeBinding: {
        repositoryId: REPOSITORY_ID,
        installationId: INSTALLATION_ID,
        instanceId: INSTANCE_ID,
        runtimeId: "reservation-12",
        runtimeEpoch: RUNTIME_EPOCH,
        leaseId: "reservation-12",
        clusterId: "cluster-other",
        active: true,
        authority: "post-absence-target" as const,
      },
    },
    {
      name: "an observed-writer binding instead of the post-absence target",
      runtimeBinding: {
        repositoryId: REPOSITORY_ID,
        installationId: INSTALLATION_ID,
        instanceId: INSTANCE_ID,
        runtimeId: "reservation-12",
        runtimeEpoch: RUNTIME_EPOCH,
        leaseId: "reservation-12",
        clusterId: CLUSTER_ID,
        active: true,
        authority: "observed-writer" as const,
      },
    },
    {
      name: "a retired target epoch",
      runtimeBinding: {
        repositoryId: REPOSITORY_ID,
        installationId: INSTALLATION_ID,
        instanceId: INSTANCE_ID,
        runtimeId: "reservation-12",
        runtimeEpoch: RUNTIME_EPOCH - 1,
        leaseId: "reservation-12",
        clusterId: CLUSTER_ID,
        active: true,
        authority: "post-absence-target" as const,
      },
    },
  ])("rejects a pre-ready cluster binding from $name", async ({ runtimeBinding }) => {
    const { controlPlane } = await makeHarness(
      true,
      operation(),
      artifactStatement(),
      "12345",
      [],
      {
        instance: {
          observedState: "absent",
          observedRuntimeEpoch: null,
          clusterId: null,
          reservationState: "reserved",
        },
        runtimeBinding,
      },
    );

    const response = await controlPlane.request(`/operations/${OPERATION_ID}/auth-probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "lease",
        workerId: WORKER_ID,
        leaseToken: LEASE_TOKEN,
        leaseEpoch: 3,
        assignment: assignment(),
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "CURRENT_BINDING_REQUIRED" } });
  });

  it("rejects a post-absence target whose reservation ID differs from the leased operation", async () => {
    const { controlPlane } = await makeHarness(
      true,
      { ...operation(), reservationId: "reservation-other" },
      artifactStatement(),
      "12345",
      [],
      {
        instance: {
          observedState: "absent",
          observedRuntimeEpoch: null,
          clusterId: null,
          reservationState: "reserved",
        },
        runtimeBinding: {
          repositoryId: REPOSITORY_ID,
          installationId: INSTALLATION_ID,
          instanceId: INSTANCE_ID,
          runtimeId: "reservation-12",
          runtimeEpoch: RUNTIME_EPOCH,
          leaseId: "reservation-12",
          clusterId: CLUSTER_ID,
          active: true,
          authority: "post-absence-target",
        },
      },
    );

    const response = await controlPlane.request(`/operations/${OPERATION_ID}/auth-probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "lease",
        workerId: WORKER_ID,
        leaseToken: LEASE_TOKEN,
        leaseEpoch: 3,
        assignment: assignment(),
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "CURRENT_BINDING_REQUIRED" } });
  });

  it("issues a read-only grant after real binding, operation, artifact, and GitHub checks even when index and platform digests differ", async () => {
    const { controlPlane, pair } = await makeHarness();
    const response = await controlPlane.request(`/operations/${OPERATION_ID}/auth-probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "lease",
        workerId: WORKER_ID,
        leaseToken: LEASE_TOKEN,
        leaseEpoch: 3,
        assignment: assignment(),
      }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const grants = await response.json() as {
      validGrant: string;
      wrongRepositoryGrant: string;
      wrongEpochGrant: string;
      permissions: readonly string[];
      grantPolicyMatched: boolean;
      controlServicePolicyMatched: boolean;
    };
    expect(grants.permissions).toEqual(["read"]);
    expect(grants.grantPolicyMatched).toBe(true);
    expect(grants.controlServicePolicyMatched).toBe(true);

    const verified = await verifyAccessGrant({
      token: grants.validGrant,
      expectedIssuer: GATEWAY_ORIGIN,
      expectedAudience: INSTANCE_ORIGIN,
      expectedInstanceId: INSTANCE_ID,
      expectedRepositoryId: REPOSITORY_ID,
      expectedRuntimeEpoch: RUNTIME_EPOCH,
      requiredPermissions: ["read"],
      now: NOW,
      clockSkewSeconds: 0,
      resolveKey: async (kid) => kid === "gateway-probe-test" ? pair.publicKey : null,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.value.permissions).toEqual(["read"]);

    const wrongRepository = await verifyAccessGrant({
      token: grants.wrongRepositoryGrant,
      expectedIssuer: GATEWAY_ORIGIN,
      expectedAudience: INSTANCE_ORIGIN,
      expectedInstanceId: INSTANCE_ID,
      expectedRepositoryId: REPOSITORY_ID,
      expectedRuntimeEpoch: RUNTIME_EPOCH,
      now: NOW,
      clockSkewSeconds: 0,
      resolveKey: async () => pair.publicKey,
    });
    const wrongEpoch = await verifyAccessGrant({
      token: grants.wrongEpochGrant,
      expectedIssuer: GATEWAY_ORIGIN,
      expectedAudience: INSTANCE_ORIGIN,
      expectedInstanceId: INSTANCE_ID,
      expectedRepositoryId: REPOSITORY_ID,
      expectedRuntimeEpoch: RUNTIME_EPOCH,
      now: NOW,
      clockSkewSeconds: 0,
      resolveKey: async () => pair.publicKey,
    });
    expect(wrongRepository.ok).toBe(false);
    expect(wrongEpoch.ok).toBe(false);
  });

  it("denies fresh grant issuance when GitHub read membership is absent", async () => {
    const { controlPlane } = await makeHarness(false);
    const response = await controlPlane.request(`/operations/${OPERATION_ID}/auth-probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "lease",
        workerId: WORKER_ID,
        leaseToken: LEASE_TOKEN,
        leaseEpoch: 3,
        assignment: assignment(),
      }),
    });
    expect(response.status).toBe(403);
  });

  it("maps a Stable system operation to an accepted same-instance user and rechecks that user's current GitHub access", async () => {
    const { controlPlane, authorizedActors } = await makeHarness(
      true,
      operation(),
      artifactStatement(),
      "system:stable-release-canary",
      [{ actor_id: "12345" }],
    );
    const response = await controlPlane.request(`/operations/${OPERATION_ID}/auth-probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "lease",
        workerId: WORKER_ID,
        leaseToken: LEASE_TOKEN,
        leaseEpoch: 3,
        assignment: assignment(),
      }),
    });
    expect(response.status).toBe(200);
    expect(authorizedActors).toEqual(["12345"]);

    const noUserAuthority = await makeHarness(
      true,
      operation(),
      artifactStatement(),
      "system:stable-release",
      [],
    );
    const denied = await noUserAuthority.controlPlane.request(`/operations/${OPERATION_ID}/auth-probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "lease",
        workerId: WORKER_ID,
        leaseToken: LEASE_TOKEN,
        leaseEpoch: 3,
        assignment: assignment(),
      }),
    });
    expect(denied.status).toBe(403);
    expect(noUserAuthority.authorizedActors).toEqual([]);
  });

  it.each(["b".repeat(40), null])("accepts a checkpointed compatible rollback after retirement with remote %s", async (remoteCommit) => {
    const priorIndex = `sha256:${"5".repeat(64)}`;
    const priorPlatform = `sha256:${"6".repeat(64)}`;
    const priorComposition = `sha256:${"7".repeat(64)}`;
    const failedIndex = `sha256:${"8".repeat(64)}`;
    const failedPlatform = `sha256:${"9".repeat(64)}`;
    const failedComposition = `sha256:${"a".repeat(64)}`;
    const priorPersistence = {
      contractVersion: "scriptorium-persistence/v1",
      readable: [{ formatId: "scriptorium.document", versions: [1, 2] }],
      writable: [{ formatId: "scriptorium.document", version: 1 }],
    };
    const targetPersistence = {
      contractVersion: "scriptorium-persistence/v1",
      readable: [{ formatId: "scriptorium.document", versions: [2] }],
      writable: [{ formatId: "scriptorium.document", version: 2 }],
    };
    const targetEpoch = 12;
    const rollbackEpoch = 13;
    const proof = {
      instanceId: INSTANCE_ID,
      repositoryId: REPOSITORY_ID,
      retiredRuntimeEpoch: targetEpoch,
      providerObservationId: "provider-observation-99",
      censusObservedAt: new Date(NOW_MS - 500).toISOString(),
      remainingWriters: 0,
      evidenceIdentities: ["pod-uid-failed-target"],
      source: "runtime-provider-census",
    };
    const quiesceReceipt = {
      contractVersion: "scriptorium-platform/v1",
      operationId: OPERATION_ID,
      instanceId: INSTANCE_ID,
      runtimeEpoch: targetEpoch,
      quiesceRevision: "quiesce-rev-12",
      disposition: "safe",
      activeMutations: 0,
      activeJobs: 0,
      restartableJobs: 0,
      pendingCheckpoints: 0,
      uncertainPublication: false,
      lastConfirmedRemoteRevision: remoteCommit,
      reasonCodes: [],
      observedAt: new Date(NOW_MS - 3_000).toISOString(),
    };
    const compatibilityEvidence = {
      contractVersion: "praetorium-rollback-compatibility/v1",
      instanceId: INSTANCE_ID,
      repositoryId: REPOSITORY_ID,
      runtimeEpoch: targetEpoch,
      imageDigest: failedIndex,
      compositionManifestDigest: failedComposition,
      providerObservationId: "producer-scan-99",
      providerObservedAt: new Date(NOW_MS - 2_000).toISOString(),
      remoteObservedAt: new Date(NOW_MS - 3_000).toISOString(),
      observedAt: new Date(NOW_MS - 1_000).toISOString(),
      observedRemoteCommit: remoteCommit,
      quiesceRevision: "quiesce-rev-12",
      quiesceRemoteCommit: remoteCommit,
      formats: remoteCommit === null ? [] : [{ formatId: "scriptorium.document", version: 2 }],
    };
    const previousDeployment = {
      revisionId: "revision-prior",
      repositoryId: REPOSITORY_ID,
      imageDigest: priorIndex,
      platformManifestDigest: priorPlatform,
      compositionManifestDigest: priorComposition,
      enabledModuleIds: [],
      grantPolicy: assignment().grantPolicy,
      controlServicePolicy: assignment().controlServicePolicy,
      persistence: priorPersistence,
    };
    const targetDeployment = {
      revisionId: "revision-failed-target",
      repositoryId: REPOSITORY_ID,
      imageDigest: failedIndex,
      platformManifestDigest: failedPlatform,
      compositionManifestDigest: failedComposition,
      enabledModuleIds: [],
      persistence: targetPersistence,
    };
    const lifecycle = {
      id: OPERATION_ID,
      instanceId: INSTANCE_ID,
      repositoryId: REPOSITORY_ID,
      generation: GENERATION,
      clusterId: CLUSTER_ID,
      kind: "redeploy",
      phase: "starting-target",
      runtimeEpoch: rollbackEpoch,
      targetRevisionId: "revision-failed-target",
      targetEpoch,
      rollbackEpoch,
      current: {
        instanceId: INSTANCE_ID,
        repositoryId: REPOSITORY_ID,
        generation: GENERATION,
        clusterId: CLUSTER_ID,
        runtimeEpoch: 10,
        revisionId: "revision-prior",
        deployment: previousDeployment,
      },
      target: targetDeployment,
      quiesceReceipt,
      writerAbsenceProof: proof,
      rollbackCompatibilityEvidence: compatibilityEvidence,
      rollbackCompatible: true,
    };
    const rollbackOperation = {
      ...operation(),
      kind: "redeploy" as const,
      runtimeEpoch: rollbackEpoch,
      deploymentRevisionId: "revision-failed-target",
      checkpoint: { schemaVersion: 1, lifecycle, writerAbsenceProof: proof },
    };
    const rollbackAssignment = {
      ...assignment(),
      runtimeEpoch: rollbackEpoch,
      revisionId: "revision-prior",
      imageDigest: priorIndex,
      platformManifestDigest: priorPlatform,
      compositionManifestDigest: priorComposition,
    };
    const { controlPlane } = await makeHarness(
      true,
      rollbackOperation,
      artifactStatement(priorIndex, priorPlatform, priorComposition),
    );
    const requestBody = {
      mode: "lease",
      workerId: WORKER_ID,
      leaseToken: LEASE_TOKEN,
      leaseEpoch: 3,
      assignment: rollbackAssignment,
    };
    const response = await controlPlane.request(`/operations/${OPERATION_ID}/auth-probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    expect(response.status, await response.clone().text()).toBe(200);

    const gappedRollbackEpoch = rollbackEpoch + 1;
    const gappedLifecycle = {
      ...lifecycle,
      runtimeEpoch: gappedRollbackEpoch,
      rollbackEpoch: gappedRollbackEpoch,
    };
    const gappedOperation = {
      ...rollbackOperation,
      runtimeEpoch: gappedRollbackEpoch,
      checkpoint: { schemaVersion: 1, lifecycle: gappedLifecycle, writerAbsenceProof: proof },
    };
    const gappedAssignment = { ...rollbackAssignment, runtimeEpoch: gappedRollbackEpoch };
    const gappedResponse = await (await makeHarness(
      true,
      gappedOperation,
      artifactStatement(priorIndex, priorPlatform, priorComposition),
    )).controlPlane.request(`/operations/${OPERATION_ID}/auth-probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...requestBody, assignment: gappedAssignment }),
    });
    expect(gappedResponse.status).toBe(409);

    const incompatibleLifecycle = {
      ...lifecycle,
      rollbackCompatible: false,
      rollbackCompatibilityEvidence: {
        ...compatibilityEvidence,
        formats: [{ formatId: "scriptorium.document", version: 3 }],
      },
    };
    const incompatibleOperation = {
      ...rollbackOperation,
      checkpoint: { schemaVersion: 1, lifecycle: incompatibleLifecycle, writerAbsenceProof: proof },
    };
    const denied = await (await makeHarness(
      true,
      incompatibleOperation,
      artifactStatement(priorIndex, priorPlatform, priorComposition),
    )).controlPlane.request(`/operations/${OPERATION_ID}/auth-probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    expect(denied.status).toBe(409);
  });
});
