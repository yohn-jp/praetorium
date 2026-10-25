import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { InstanceService, RepositoryRegistryService } from "@praetorium/application/instances";
import { OperationService } from "@praetorium/application/operations";
import {
  D1PlatformStore,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
} from "@praetorium/persistence/d1";
import { createOperationAdminRoutes } from "./operation-admin-routes.js";

const MIGRATIONS = [
  "0001_repository_platform.sql",
  "0002_stable_release_rollouts.sql",
  "0003_staged_configurations.sql",
  "0004_runtime_git_credentials.sql",
  "0006_application_origins.sql",
  "0009_runtime_authority.sql",
];
const liveDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of liveDatabases.splice(0)) database.close();
});

describe("Control Plane operation admin routes against migrated SQLite D1", () => {
  it("projects only schema-validated operation evidence without arbitrary checkpoint secrets", async () => {
    const h = createHarness();
    const resolved = await h.registry.resolveOrCreate(registryInput(71, "instance-evidence"));
    const failed = await makeFailedStart(h.database, h.instances, resolved.binding);
    h.database
      .prepare("UPDATE operations SET checkpoint_json=? WHERE operation_id=?")
      .run(
        JSON.stringify({
          lifecycle: {
            readinessEvidence: { leaseToken: "must-not-leak" },
            rollbackCompatibilityEvidence: { secret: "must-not-leak" },
          },
          privateKey: "must-not-leak",
        }),
        failed.id,
      );
    const response = await h.routes.request(`/v1/operations/${failed.id}/evidence`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("must-not-leak");
    expect(JSON.parse(text)).toMatchObject({
      operation: { id: failed.id },
      readinessEvidence: null,
      rollbackCompatibilityEvidence: null,
    });
  });
  it("pages at most 50 instance audit events and returns only the action allowlist", async () => {
    const { database, registry, routes } = createHarness();
    const first = await registry.resolveOrCreate(registryInput(71, "instance-a"));
    const other = await registry.resolveOrCreate(registryInput(72, "instance-b"));
    for (let index = 0; index < 53; index += 1) {
      database
        .prepare(
          `INSERT INTO audit_events (
             event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
             action, outcome, request_id, metadata_json, occurred_at
           ) VALUES (?, 71, ?, NULL, 'user-1', 'user', 'instance.start', 'accepted', NULL, ?, ?)`,
        )
        .run(
          `audit-${String(index).padStart(3, "0")}`,
          first.instance.instanceId,
          JSON.stringify({
            generation: index,
            runtimeEpoch: 4,
            authorizationRevision: 3,
            secret: "must-not-escape",
            checkpoint: { contents: "private" },
            leaseToken: "private-lease",
          }),
          index,
        );
    }
    database
      .prepare(
        `INSERT INTO audit_events (
           event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
           action, outcome, request_id, metadata_json, occurred_at
         ) VALUES ('other-repo', 72, ?, NULL, 'user-2', 'user', 'instance.start', 'accepted', NULL, '{}', 999)`,
      )
      .run(other.instance.instanceId);

    const firstPage = await routes.request(`/v1/instances/${first.instance.instanceId}/audit`);
    expect(firstPage.status).toBe(200);
    const page = (await firstPage.json()) as {
      events: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(page.events).toHaveLength(50);
    expect(page.events[0]).toMatchObject({
      instanceId: first.instance.instanceId,
      actorId: "user-1",
      action: "instance.start",
      metadata: { generation: 52, runtimeEpoch: 4, authorizationRevision: 3 },
    });
    expect(page.events[0]).not.toHaveProperty("requestId");
    expect(JSON.stringify(page)).not.toContain("must-not-escape");
    expect(JSON.stringify(page)).not.toContain("private-lease");
    expect(JSON.stringify(page)).not.toContain("checkpoint");
    expect(page.nextCursor).toEqual(expect.any(String));

    const secondPageResponse = await routes.request(
      `/v1/instances/${first.instance.instanceId}/audit?cursor=${page.nextCursor}`,
    );
    const secondPage = (await secondPageResponse.json()) as {
      events: Array<{ eventId: string }>;
      nextCursor: string | null;
    };
    expect(secondPageResponse.status).toBe(200);
    expect(secondPage.events).toHaveLength(4);
    expect(secondPage.events.map((event) => event.eventId)).not.toContain("other-repo");
    expect(secondPage.nextCursor).toBeNull();

    const invalidCursor = await routes.request(
      `/v1/instances/${first.instance.instanceId}/audit?cursor=not-a-cursor`,
    );
    expect(invalidCursor.status).toBe(400);
    const oversizedPage = await routes.request(
      `/v1/instances/${first.instance.instanceId}/audit?limit=51`,
    );
    expect(oversizedPage.status).toBe(400);
  });

  it("retries current running intent into a new runtime epoch and replays only the public operation", async () => {
    const { database, registry, instances, routes } = createHarness();
    const resolved = await registry.resolveOrCreate(registryInput(71, "instance-run"));
    const failed = await makeFailedStart(database, instances, resolved.binding);
    const request = retryRequest(failed.id, {
      actorId: "trusted-gateway-user-71",
      bindingEpoch: resolved.binding.bindingEpoch,
      authorizationRevision: resolved.binding.authorizationRevision,
      expectedGeneration: failed.generation,
      idempotencyKey: "retry-running-1",
    });

    const response = await routes.fetch(request);
    expect(response.status).toBe(200);
    const operation = (await response.json()) as Record<string, unknown>;
    expect(operation).toMatchObject({
      instanceId: resolved.instance.instanceId,
      generation: failed.generation + 1,
      runtimeEpoch: resolved.instance.runtimeEpoch + 2,
      kind: "redeploy",
      status: "pending",
    });
    expect(Object.keys(operation).sort()).toEqual([
      "attempt",
      "createdAt",
      "generation",
      "id",
      "instanceId",
      "kind",
      "phase",
      "runtimeEpoch",
      "status",
      "updatedAt",
    ]);
    expect(operation).not.toHaveProperty("leaseToken");
    expect(operation).not.toHaveProperty("checkpoint");
    expect(operation).not.toHaveProperty("result");

    const replay = await routes.fetch(
      retryRequest(failed.id, {
        actorId: "trusted-gateway-user-71",
        bindingEpoch: resolved.binding.bindingEpoch,
        authorizationRevision: resolved.binding.authorizationRevision,
        expectedGeneration: failed.generation,
        idempotencyKey: "retry-running-1",
      }),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(operation);
    expect(database.prepare("SELECT count(*) AS count FROM operations").get()).toMatchObject({
      count: 2,
    });
  });

  it.each([false, true])("uses a stop retry without advancing runtime epoch (explicit stopped verification: %s)", async (reverifyStopped) => {
    const { database, registry, instances, routes } = createHarness();
    const resolved = await registry.resolveOrCreate(registryInput(71, "instance-stop"));
    const started = await instances.requestDesiredState({
      repositoryId: 71,
      bindingEpoch: resolved.binding.bindingEpoch,
      authorizationRevision: resolved.binding.authorizationRevision,
      desiredState: "running",
      actorId: "user-1",
      idempotencyKey: "initial-running",
      requestId: "initial-running-request",
      now: 10,
      expectedGeneration: 0,
    });
    if (!started.operation) throw new Error("expected initial start operation");
    database
      .prepare(
        "UPDATE operations SET status = 'succeeded', phase = 'complete' WHERE operation_id = ?",
      )
      .run(started.operation.id);
    const stopped = await instances.requestDesiredState({
      repositoryId: 71,
      bindingEpoch: resolved.binding.bindingEpoch,
      authorizationRevision: resolved.binding.authorizationRevision,
      desiredState: "stopped",
      actorId: "user-1",
      idempotencyKey: "initial-stopped",
      requestId: "initial-stopped-request",
      now: 20,
      expectedGeneration: 1,
    });
    if (!stopped.operation) throw new Error("expected initial stop operation");
    database
      .prepare("UPDATE operations SET status = ?, phase = ? WHERE operation_id = ?")
      .run(reverifyStopped ? "succeeded" : "failed", reverifyStopped ? "complete" : "failed", stopped.operation.id);
    database
      .prepare("UPDATE logical_instances SET observed_state = ?, observed_runtime_epoch = ? WHERE instance_id = ?")
      .run(reverifyStopped ? "stopped" : "unknown", stopped.operation.runtimeEpoch, resolved.instance.instanceId);

    if (reverifyStopped) {
      const ordinaryRetry = await routes.fetch(retryRequest(stopped.operation.id, {
        actorId:"trusted-gateway-user-71",bindingEpoch:resolved.binding.bindingEpoch,
        authorizationRevision:resolved.binding.authorizationRevision,
        expectedGeneration:stopped.operation.generation,idempotencyKey:"ordinary-successful-stop",
      }));
      expect(ordinaryRetry.status).toBe(409);
    }

    const response = await routes.fetch(
      retryRequest(stopped.operation.id, {
        actorId: "trusted-gateway-user-71",
        bindingEpoch: resolved.binding.bindingEpoch,
        authorizationRevision: resolved.binding.authorizationRevision,
        expectedGeneration: stopped.operation.generation,
        idempotencyKey: "retry-stopped-1",
        ...(reverifyStopped ? { reverifyStopped:true } : {}),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "stop",
      generation: stopped.operation.generation + 1,
      runtimeEpoch: stopped.operation.runtimeEpoch,
    });
    expect(database.prepare("SELECT runtime_epoch FROM logical_instances").get()).toMatchObject({
      runtime_epoch: stopped.operation.runtimeEpoch,
    });
    if (reverifyStopped) {
      const replay = await routes.fetch(retryRequest(stopped.operation.id, {
        actorId:"trusted-gateway-user-71",bindingEpoch:resolved.binding.bindingEpoch,
        authorizationRevision:resolved.binding.authorizationRevision,
        expectedGeneration:stopped.operation.generation,idempotencyKey:"retry-stopped-1",reverifyStopped:true,
      }));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({kind:"stop",generation:stopped.operation.generation+1,runtimeEpoch:stopped.operation.runtimeEpoch});
      expect(database.prepare("SELECT count(*) AS count FROM operations").get()).toMatchObject({count:3});
    }
  });

  it("rejects stale generations, active work, stale authorization on replay, and extra body fields", async () => {
    const { database, registry, instances, routes } = createHarness();
    const resolved = await registry.resolveOrCreate(registryInput(71, "instance-guards"));
    const failed = await makeFailedStart(database, instances, resolved.binding);
    const active = database.prepare(
      `INSERT INTO operations (
         operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status, phase,
         idempotency_scope, idempotency_key, request_hash, actor_id, authorization_revision,
         created_at, updated_at
       ) VALUES ('active-op', ?, 71, ?, 1, 'start', 'claimed', 'starting-target',
         'repository:71', 'active-key', 'sha256:active', 'worker', 3, 30, 30)`,
    );
    active.run(resolved.instance.instanceId, failed.generation);
    const body = {
      actorId: "trusted-gateway-user-71",
      bindingEpoch: resolved.binding.bindingEpoch,
      authorizationRevision: resolved.binding.authorizationRevision,
      expectedGeneration: failed.generation,
      idempotencyKey: "retry-blocked-by-active",
    };
    const activeResponse = await routes.fetch(retryRequest(failed.id, body));
    expect(activeResponse.status).toBe(409);
    expect(database.prepare("SELECT generation FROM logical_instances").get()).toMatchObject({
      generation: failed.generation,
    });
    database.prepare("DELETE FROM operations WHERE operation_id = 'active-op'").run();

    const advanced = await instances.requestDesiredState({
      repositoryId: 71,
      bindingEpoch: resolved.binding.bindingEpoch,
      authorizationRevision: resolved.binding.authorizationRevision,
      desiredState: "stopped",
      actorId: "user-1",
      idempotencyKey: "new-configuration-state",
      requestId: "new-state-request",
      now: 40,
      expectedGeneration: failed.generation,
    });
    expect(advanced.operation).not.toBeNull();
    const stale = await routes.fetch(
      retryRequest(failed.id, {
        ...body,
        idempotencyKey: "retry-stale-old-generation",
      }),
    );
    expect(stale.status).toBe(409);
    expect(database.prepare("SELECT count(*) AS count FROM operations").get()).toMatchObject({
      count: 2,
    });

    const freshHarness = createHarness();
    const freshResolved = await freshHarness.registry.resolveOrCreate(
      registryInput(71, "instance-auth"),
    );
    const freshFailed = await makeFailedStart(
      freshHarness.database,
      freshHarness.instances,
      freshResolved.binding,
    );
    const retryBody = {
      actorId: "trusted-gateway-user-71",
      bindingEpoch: freshResolved.binding.bindingEpoch,
      authorizationRevision: freshResolved.binding.authorizationRevision,
      expectedGeneration: freshFailed.generation,
      idempotencyKey: "retry-auth-replay",
    };
    const accepted = await freshHarness.routes.fetch(retryRequest(freshFailed.id, retryBody));
    expect(accepted.status).toBe(200);
    freshHarness.database
      .prepare("UPDATE repository_bindings SET authorization_revision = 4 WHERE repository_id = 71")
      .run();
    const staleAuthReplay = await freshHarness.routes.fetch(
      retryRequest(freshFailed.id, retryBody),
    );
    expect(staleAuthReplay.status).toBe(409);

    const malformed = await freshHarness.routes.fetch(
      retryRequest(freshFailed.id, { ...retryBody, forceNewRuntime: true }),
    );
    expect(malformed.status).toBe(400);
  });
});

function createHarness() {
  const database = new DatabaseSync(":memory:");
  liveDatabases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    database.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const db = new SQLiteD1Database(database);
  const store = new D1PlatformStore(db);
  let operationCounter = 0;
  const instances = new InstanceService(store, () => `operation-${++operationCounter}`);
  let instanceCounter = 0;
  const registry = new RepositoryRegistryService(store, () => `instance-${++instanceCounter}`);
  let leaseCounter = 0;
  const operations = new OperationService(
    store,
    () => `provisioner-lease-${++leaseCounter}-with-sufficient-length`,
  );
  const routes = createOperationAdminRoutes({ db, instances, operations, now: () => 50 });
  return { database, db, store, instances, registry, operations, routes };
}

function registryInput(repositoryId: number, instanceId: string) {
  return {
    repository: {
      repositoryId,
      installationId: 81,
      owner: "praetorium",
      name: `repository-${repositoryId}`,
      authorizationRevision: 3,
    },
    actor: { id: "user-1", kind: "user" as const },
    requestId: `resolve-${instanceId}`,
    idempotencyKey: `resolve-${instanceId}`,
    now: 1,
    instanceId,
  };
}

async function makeFailedStart(
  database: DatabaseSync,
  instances: InstanceService,
  binding: { repositoryId: number; bindingEpoch: number; authorizationRevision: number },
) {
  const result = await instances.requestDesiredState({
    repositoryId: binding.repositoryId,
    bindingEpoch: binding.bindingEpoch,
    authorizationRevision: binding.authorizationRevision,
    desiredState: "running",
    actorId: "user-1",
    idempotencyKey: `initial-start-${binding.repositoryId}`,
    requestId: `initial-start-${binding.repositoryId}-request`,
    now: 10,
    expectedGeneration: 0,
  });
  if (!result.operation) throw new Error("expected a start operation");
  database
    .prepare("UPDATE operations SET status = 'failed', phase = 'failed' WHERE operation_id = ?")
    .run(result.operation.id);
  return result.operation;
}

function retryRequest(operationId: string, body: unknown): Request {
  return new Request(`https://control-plane.internal/v1/operations/${operationId}/retry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

class SQLiteD1Database implements D1Database {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    return new SQLiteD1Statement(this.database, query, []);
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push(await (statement as SQLiteD1Statement).run<T>());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      release();
    }
  }
}

class SQLiteD1Statement implements D1PreparedStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly values: readonly SQLInputValue[],
  ) {}

  bind(
    ...values: readonly (string | number | null | ArrayBuffer | Uint8Array)[]
  ): D1PreparedStatement {
    return new SQLiteD1Statement(this.database, this.query, values.map(sqlInput));
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.database.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return {
      results: this.database.prepare(this.query).all(...this.values) as T[],
      meta: { changes: 0 },
    };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const result = this.database.prepare(this.query).run(...this.values);
    return { results: [] as T[], meta: { changes: Number(result.changes) } };
  }
}

function sqlInput(value: string | number | null | ArrayBuffer | Uint8Array): SQLInputValue {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}
