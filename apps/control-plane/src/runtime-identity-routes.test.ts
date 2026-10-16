import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { OperationService } from "@praetorium/application/operations";
import {
  D1PlatformStore,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
} from "@praetorium/persistence/d1";
import { createRuntimeBindingMetadataReader } from "./runtime-binding.js";
import { createRuntimeIdentityRoutes } from "./runtime-identity-routes.js";

const NOW = Date.parse("2026-10-17T00:00:10.000Z");
const REPOSITORY_ID = 7001;
const INSTANCE_ID = "ins_repo-7001";
const INSTALLATION_ID = 9001;
const CLUSTER_ID = "cluster-1";
const WORKER_ID = "provisioner-1";
const TARGET_RESERVATION_ID = "res_target-5";
const OPERATION_ID = "op-target-5";
const LEASE_TOKEN = "lease-secret-".padEnd(64, "x");
const liveDatabases: DatabaseSync[] = [];

class SQLiteD1 implements D1Database {
  readonly database = new DatabaseSync(":memory:");

  constructor() {
    liveDatabases.push(this.database);
  }

  prepare(query: string): D1PreparedStatement {
    return new SQLiteD1Statement(this.database, query, this.database.prepare(query));
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result<unknown>[] = [];
      for (const statement of statements)
        results.push(await (statement as SQLiteD1Statement).execute());
      this.database.exec("COMMIT");
      return results as D1Result<T>[];
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class SQLiteD1Statement implements D1PreparedStatement {
  private values: readonly (string | number | null | ArrayBuffer | Uint8Array)[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly statement: StatementSync,
  ) {}

  bind(
    ...values: readonly (string | number | null | ArrayBuffer | Uint8Array)[]
  ): D1PreparedStatement {
    this.values = values;
    return this;
  }

  private sqlValues(): SQLInputValue[] {
    return this.values.map((value) =>
      value instanceof ArrayBuffer ? new Uint8Array(value) : value,
    );
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.statement.get(...this.sqlValues()) as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return { results: this.statement.all(...this.sqlValues()) as T[], meta: { changes: 0 } };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const result = this.statement.run(...this.sqlValues());
    return { results: [], meta: { changes: Number(result.changes) } };
  }

  async execute(): Promise<D1Result> {
    if (/^\s*(SELECT|WITH)\b/iu.test(this.query))
      return { results: this.statement.all(...this.sqlValues()), meta: { changes: 0 } };
    const result = this.statement.run(...this.sqlValues());
    return { results: [], meta: { changes: Number(result.changes) } };
  }
}

function installSchema(db: SQLiteD1): void {
  db.database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "../migrations/0001_repository_platform.sql",
    "../migrations/0002_stable_release_rollouts.sql",
    "../migrations/0003_staged_configurations.sql",
  ])
    db.database.exec(readFileSync(new URL(migration, import.meta.url), "utf8"));
}

function insertInstance(db: SQLiteD1, withTargetOperation: boolean): void {
  db.database
    .prepare(
      `INSERT INTO logical_instances (
         instance_id, repository_id, generation, runtime_epoch, desired_state,
         observed_generation, observed_runtime_epoch, observed_state,
         observed_revision_id, desired_revision_id, current_artifact_digest,
         desired_artifact_digest, reservation_state, reservation_id, created_at, updated_at
       ) VALUES (?, ?, 8, 5, 'running', 7, 4, 'ready', 'revision-4', 'revision-5',
         'sha256:current', 'sha256:target', 'reserved', ?, ?, ?)`,
    )
    .run(
      INSTANCE_ID,
      REPOSITORY_ID,
      withTargetOperation ? TARGET_RESERVATION_ID : "res_current-4",
      NOW - 1000,
      NOW - 1000,
    );
  db.database
    .prepare(
      `INSERT INTO repository_bindings (
         repository_id, instance_id, installation_id, owner, name,
         authorization_revision, binding_epoch, suspended, created_at, updated_at
       ) VALUES (?, ?, ?, 'owner', 'repo', 3, 2, 0, ?, ?)`,
    )
    .run(REPOSITORY_ID, INSTANCE_ID, INSTALLATION_ID, NOW - 1000, NOW - 1000);
  db.database
    .prepare(
      `INSERT INTO runtime_reservations (
         reservation_id, instance_id, repository_id, runtime_epoch, generation,
         cluster_id, status, capacity_snapshot_epoch, cpu_milli, memory_mib,
         ephemeral_storage_mib, created_at, updated_at
       ) VALUES ('res_current-4', ?, ?, 4, 7, ?, 'reserved', 1,
         100, 256, 128, ?, ?)`,
    )
    .run(INSTANCE_ID, REPOSITORY_ID, CLUSTER_ID, NOW - 1000, NOW - 1000);

  if (!withTargetOperation) return;
  const proof = {
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    retiredRuntimeEpoch: 4,
    providerObservationId: "provider-observation-61",
    censusObservedAt: new Date(NOW - 500).toISOString(),
    remainingWriters: 0,
    evidenceIdentities: ["provider-pod-17"],
    source: "runtime-provider-census",
  };
  const absenceCheckpoint = JSON.stringify({
    schemaVersion: 1,
    lifecycle: { instanceId: INSTANCE_ID, repositoryId: REPOSITORY_ID, writerAbsenceProof: proof },
    writerAbsenceProof: proof,
  });
  const currentCheckpoint = JSON.stringify({
    schemaVersion: 1,
    lifecycle: {
      instanceId: INSTANCE_ID,
      repositoryId: REPOSITORY_ID,
      phase: "starting-target",
      writerAbsenceProof: proof,
    },
    writerAbsenceProof: proof,
  });
  db.database
    .prepare(
      `INSERT INTO runtime_reservations (
         reservation_id, instance_id, repository_id, runtime_epoch, generation,
         cluster_id, status, capacity_snapshot_epoch, cpu_milli, memory_mib,
         ephemeral_storage_mib, created_at, updated_at
       ) VALUES (?, ?, ?, 5, 8, ?, 'reserved', 1, 100, 256, 128, ?, ?)`,
    )
    .run(TARGET_RESERVATION_ID, INSTANCE_ID, REPOSITORY_ID, CLUSTER_ID, NOW - 500, NOW - 500);
  db.database
    .prepare(
      `INSERT INTO operations (
         operation_id, instance_id, repository_id, generation, runtime_epoch, kind,
         status, phase, attempt, lease_epoch, worker_id, lease_token, lease_expires_at,
         report_sequence, checkpoint_sequence, checkpoint_json, cluster_id, reservation_id,
         idempotency_scope, idempotency_key, request_hash, actor_id,
         authorization_revision, created_at, updated_at
       ) VALUES (?, ?, ?, 8, 5, 'redeploy', 'running', 'starting-target', 1, 4, ?, ?, ?,
         1, 2, ?, ?, ?, 'repo:7001', 'request-5', 'request-hash', 'user-1', 3, ?, ?)`,
    )
    .run(
      OPERATION_ID,
      INSTANCE_ID,
      REPOSITORY_ID,
      WORKER_ID,
      LEASE_TOKEN,
      NOW + 17_000,
      currentCheckpoint,
      CLUSTER_ID,
      TARGET_RESERVATION_ID,
      NOW - 700,
      NOW - 100,
    );
  db.database
    .prepare(
      `INSERT INTO operation_checkpoints (
         operation_id, sequence, phase, runtime_epoch, checkpoint_json, actor_id, occurred_at
       ) VALUES (?, 1, 'old-writer-absent', 5, ?, ?, ?)`,
    )
    .run(OPERATION_ID, absenceCheckpoint, WORKER_ID, NOW - 500);
  db.database
    .prepare(
      `INSERT INTO operation_checkpoints (
         operation_id, sequence, phase, runtime_epoch, checkpoint_json, actor_id, occurred_at
       ) VALUES (?, 2, 'starting-target', 5, ?, ?, ?)`,
    )
    .run(OPERATION_ID, currentCheckpoint, WORKER_ID, NOW - 400);
}

async function harness(withTargetOperation: boolean) {
  const db = new SQLiteD1();
  installSchema(db);
  insertInstance(db, withTargetOperation);
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const signingJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const operations = new OperationService(new D1PlatformStore(db), () => "unused-new-lease-token");
  const app = createRuntimeIdentityRoutes({
    db,
    runtimeBindings: createRuntimeBindingMetadataReader({ db, now: () => NOW }),
    operations,
    signingKey: { kid: "runtime-identity-2026-01", privateKeyJwk: signingJwk },
    issuerOrigin: "https://control.example.test",
    workerId: WORKER_ID,
    clusterId: CLUSTER_ID,
    now: () => NOW,
  });
  return { db, app, keyPair };
}

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtimeId: "res_current-4",
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    installationId: INSTALLATION_ID,
    runtimeEpoch: 4,
    leaseId: "res_current-4",
    workerId: WORKER_ID,
    clusterId: CLUSTER_ID,
    ...overrides,
  };
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

afterEach(() => {
  while (liveDatabases.length > 0) liveDatabases.pop()?.close();
});

describe("runtime identity routes", () => {
  it("publishes only the public P-256 key and returns current observed writer metadata during a pending build", async () => {
    const h = await harness(false);
    const jwksResponse = await h.app.request("/.well-known/runtime-identity-jwks.json");
    const jwks = (await jwksResponse.json()) as { keys: Record<string, unknown>[] };
    expect(jwksResponse.status).toBe(200);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      kty: "EC",
      crv: "P-256",
      alg: "ES256",
      kid: "runtime-identity-2026-01",
    });
    expect(jwks.keys[0]).not.toHaveProperty("d");

    const bindingResponse = await h.app.request("/internal/runtime-bindings/7001");
    expect(bindingResponse.status).toBe(200);
    expect(await bindingResponse.json()).toEqual({
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
      instanceId: INSTANCE_ID,
      runtimeId: "res_current-4",
      runtimeEpoch: 4,
      leaseId: "res_current-4",
      clusterId: CLUSTER_ID,
      active: true,
      authority: "observed-writer",
    });
  });

  it("issues an ES256 runtime credential from current D1 binding values", async () => {
    const h = await harness(false);
    const response = await h.app.request("/internal/provisioner/runtime-identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseRequest()),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { token: string; expiresAt: string };
    const [header, payload, signature] = result.token.split(".") as [string, string, string];
    const tokenHeader = JSON.parse(new TextDecoder().decode(decodeBase64Url(header))) as Record<
      string,
      unknown
    >;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as Record<
      string,
      unknown
    >;
    expect(tokenHeader).toEqual({ alg: "ES256", kid: "runtime-identity-2026-01", typ: "JWT" });
    expect(claims).toMatchObject({
      contractVersion: "praetorium-runtime-identity/v1",
      iss: "https://control.example.test",
      aud: "praetorium-git-broker",
      sub: "res_current-4",
      runtimeId: "res_current-4",
      instanceId: INSTANCE_ID,
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
      runtimeEpoch: 4,
      leaseId: "res_current-4",
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 300,
    });
    expect(result.expiresAt).toBe(new Date((Math.floor(NOW / 1000) + 300) * 1000).toISOString());
    const jwks = (await (
      await h.app.request("/.well-known/runtime-identity-jwks.json")
    ).json()) as {
      keys: JsonWebKey[];
    };
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwks.keys[0]!,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        asArrayBuffer(decodeBase64Url(signature)),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
  });

  it("rejects any caller binding mismatch and unknown request fields", async () => {
    const h = await harness(false);
    const valid = baseRequest();
    for (const [field, value] of Object.entries({
      runtimeId: "res_wrong",
      instanceId: "ins_wrong",
      repositoryId: 7002,
      installationId: 9002,
      runtimeEpoch: 5,
      leaseId: "res_wrong",
      workerId: "worker-wrong",
      clusterId: "cluster-wrong",
    })) {
      const response = await h.app.request("/internal/provisioner/runtime-identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...valid, [field]: value }),
      });
      expect(response.status, field).toBe(409);
    }
    const extraFieldResponse = await h.app.request("/internal/provisioner/runtime-identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...valid, userId: "user-1" }),
    });
    expect(extraFieldResponse.status).toBe(400);
  });

  it("denies requests after the D1 installation or active reservation changes", async () => {
    const changedInstallation = await harness(false);
    changedInstallation.db.database
      .prepare("UPDATE repository_bindings SET installation_id = 9002 WHERE repository_id = ?")
      .run(REPOSITORY_ID);
    const installationResponse = await changedInstallation.app.request(
      "/internal/provisioner/runtime-identity",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(baseRequest()),
      },
    );
    expect(installationResponse.status).toBe(409);

    const releasedReservation = await harness(false);
    releasedReservation.db.database
      .prepare("UPDATE runtime_reservations SET status = 'released' WHERE reservation_id = ?")
      .run("res_current-4");
    const reservationResponse = await releasedReservation.app.request(
      "/internal/provisioner/runtime-identity",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(baseRequest()),
      },
    );
    expect(reservationResponse.status).toBe(409);
  });

  it("requires a current owned operation lease for a target after writer absence and bounds expiry by the lease", async () => {
    const h = await harness(true);
    const targetRequest = baseRequest({
      runtimeId: TARGET_RESERVATION_ID,
      runtimeEpoch: 5,
      leaseId: TARGET_RESERVATION_ID,
      operationId: OPERATION_ID,
      leaseToken: LEASE_TOKEN,
      leaseEpoch: 4,
    });
    const response = await h.app.request("/internal/provisioner/runtime-identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(targetRequest),
    });
    expect(response.status).toBe(200);
    const issued = (await response.json()) as { token: string; expiresAt: string };
    const claims = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(issued.token.split(".")[1]!)),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({
      runtimeId: TARGET_RESERVATION_ID,
      runtimeEpoch: 5,
      leaseId: TARGET_RESERVATION_ID,
    });
    expect(claims.exp).toBe(Math.floor(NOW / 1000) + 17);
    expect(issued.expiresAt).toBe(new Date((Math.floor(NOW / 1000) + 17) * 1000).toISOString());

    for (const overrides of [
      { leaseToken: "wrong-token-".padEnd(64, "x") },
      { leaseEpoch: 3 },
      { workerId: "worker-other" },
      { operationId: "missing-operation" },
    ]) {
      const denied = await h.app.request("/internal/provisioner/runtime-identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...targetRequest, ...overrides }),
      });
      expect(denied.status).toBe(409);
    }

    h.db.database
      .prepare("UPDATE operations SET lease_epoch = 5 WHERE operation_id = ?")
      .run(OPERATION_ID);
    const staleLease = await h.app.request("/internal/provisioner/runtime-identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(targetRequest),
    });
    expect(staleLease.status).toBe(409);
  });

  it("enforces the actual streamed JSON body limit", async () => {
    const h = await harness(false);
    const oversized = `${JSON.stringify(baseRequest())}${" ".repeat(65_537)}`;
    const response = await h.app.request("/internal/provisioner/runtime-identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });
    expect(response.status).toBe(413);
  });
});
