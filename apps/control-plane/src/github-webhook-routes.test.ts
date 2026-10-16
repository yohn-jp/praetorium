import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { D1Database, D1PreparedStatement, D1Result } from "@praetorium/persistence/d1";
import { createGitHubWebhookRoutes, type GitHubWebhookDelivery } from "./github-webhook-routes.js";

const SECRET = "a-gateway-service-secret-with-enough-entropy";
const GITHUB_WEBHOOK_SECRET = "a-github-webhook-secret-with-enough-entropy";
const MIGRATIONS = [
  "0001_repository_platform.sql",
  "0002_stable_release_rollouts.sql",
  "0003_staged_configurations.sql",
] as const;
const liveDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of liveDatabases.splice(0)) database.close();
});

describe("Control Plane GitHub webhook route against migrated SQLite D1", () => {
  it("suspends only the exact installation repository, fences active work and deduplicates transactionally", async () => {
    const h = createHarness();
    seedBinding(h.database, "instance-71", 71, 700);
    seedBinding(h.database, "instance-72", 72, 700);
    seedBinding(h.database, "instance-73", 73, 701);
    seedOperation(h.database, "operation-71", "instance-71", 71, "redeploy", "running");
    seedOperation(h.database, "stop-71", "instance-71", 71, "stop", "pending");
    seedOperation(h.database, "operation-72", "instance-72", 72, "update", "claimed");

    const delivery = webhook({
      deliveryId: "delivery-remove-71",
      event: "installation_repositories",
      action: "removed",
      installationId: 700,
      repositoryIds: [71],
    });
    const first = await h.post(delivery);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: "accepted" });

    expect(bindingRow(h.database, 71)).toMatchObject({
      installation_id: 700,
      authorization_revision: 3,
      binding_epoch: 2,
      suspended: 1,
    });
    expect(bindingRow(h.database, 72)).toMatchObject({ binding_epoch: 1, suspended: 0 });
    expect(bindingRow(h.database, 73)).toMatchObject({ binding_epoch: 1, suspended: 0 });
    expect(operationRow(h.database, "operation-71")).toMatchObject({
      status: "blocked",
      phase: "binding-suspended",
      worker_id: null,
      lease_token: null,
      lease_expires_at: null,
    });
    expect(operationRow(h.database, "stop-71")).toMatchObject({ status: "pending" });
    expect(operationRow(h.database, "operation-72")).toMatchObject({ status: "claimed" });

    const duplicate = await h.post(delivery);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ status: "duplicate" });
    expect(bindingRow(h.database, 71)).toMatchObject({ binding_epoch: 2, suspended: 1 });
    expect(count(h.database, "github:binding:delivery-remove-71:%")).toBe(1);
    expect(count(h.database, "github:operation:delivery-remove-71:%")).toBe(1);

    const conflicting = await h.post({ ...delivery, bodyDigest: "b".repeat(64) });
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toEqual({ error: { code: "WEBHOOK_DELIVERY_CONFLICT" } });
    expect(bindingRow(h.database, 71)).toMatchObject({ binding_epoch: 2, suspended: 1 });
  });

  it("tracks unknown events and does not change bindings", async () => {
    const h = createHarness();
    seedBinding(h.database, "instance-71", 71, 700);
    const delivery = webhook({
      deliveryId: "delivery-unknown",
      event: "issues",
      action: "opened",
      installationId: 700,
      repositoryIds: [71],
    });

    const response = await h.post(delivery);
    expect(response.status).toBe(202);
    expect(bindingRow(h.database, 71)).toMatchObject({ binding_epoch: 1, suspended: 0 });
    expect(receiptRow(h.database, delivery.deliveryId)).toMatchObject({
      action: "github.webhook.delivery",
    });
    expect(count(h.database, "github:binding:delivery-unknown:%")).toBe(0);
  });

  it("conservatively suspends an installation for a selected event with no removed IDs", async () => {
    const h = createHarness();
    seedBinding(h.database, "instance-71", 71, 700);
    seedBinding(h.database, "instance-72", 72, 700);
    seedBinding(h.database, "instance-73", 73, 701);
    seedOperation(h.database, "operation-71", "instance-71", 71, "redeploy", "running");
    seedOperation(h.database, "operation-72", "instance-72", 72, "update", "claimed");

    const delivery = webhook({
      deliveryId: "delivery-selection-narrowed",
      event: "installation_repositories",
      action: "removed",
      installationId: 700,
      repositoryIds: [],
      repositorySelection: "selected",
    });
    const response = await h.post(delivery);
    expect(response.status).toBe(202);
    expect(bindingRow(h.database, 71)).toMatchObject({ binding_epoch: 2, suspended: 1 });
    expect(bindingRow(h.database, 72)).toMatchObject({ binding_epoch: 2, suspended: 1 });
    expect(bindingRow(h.database, 73)).toMatchObject({ binding_epoch: 1, suspended: 0 });
    expect(operationRow(h.database, "operation-71")).toMatchObject({
      status: "blocked",
      worker_id: null,
      lease_token: null,
      lease_expires_at: null,
    });
    expect(operationRow(h.database, "operation-72")).toMatchObject({
      status: "blocked",
      worker_id: null,
      lease_token: null,
      lease_expires_at: null,
    });

    const duplicate = await h.post(delivery);
    expect(duplicate.status).toBe(200);
    expect(bindingRow(h.database, 71)).toMatchObject({ binding_epoch: 2, suspended: 1 });
    expect(bindingRow(h.database, 72)).toMatchObject({ binding_epoch: 2, suspended: 1 });
  });

  it("passes a signed all-to-selected delivery through the actual Gateway and Control Plane factories", async () => {
    const h = createHarness();
    seedBinding(h.database, "instance-71", 71, 700);
    seedBinding(h.database, "instance-72", 72, 700);
    seedBinding(h.database, "instance-73", 73, 701);
    seedOperation(h.database, "operation-71", "instance-71", 71, "redeploy", "running");
    seedOperation(h.database, "operation-72", "instance-72", 72, "update", "claimed");

    const gatewayModule = await import(
      new URL("../../gateway/src/github-webhook.ts", import.meta.url).href
    );
    const controlPlaneClient = gatewayModule.createGitHubWebhookControlPlaneClient(
      {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          return h.routes.fetch(new Request(input, init));
        },
      },
      SECRET,
    );
    const gateway = gatewayModule.createGitHubWebhookRoutes({
      webhookSecret: GITHUB_WEBHOOK_SECRET,
      controlPlane: controlPlaneClient,
    });
    const rawBody = new TextEncoder().encode(
      JSON.stringify({
        action: "removed",
        repository_selection: "selected",
        installation: { id: 700 },
        repositories_removed: [],
      }),
    );
    const response = await gateway.request("/", {
      method: "POST",
      headers: await signedGitHubHeaders(rawBody, "delivery-all-to-selected"),
      body: rawBody,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(bindingRow(h.database, 71)).toMatchObject({ binding_epoch: 2, suspended: 1 });
    expect(bindingRow(h.database, 72)).toMatchObject({ binding_epoch: 2, suspended: 1 });
    expect(bindingRow(h.database, 73)).toMatchObject({ binding_epoch: 1, suspended: 0 });
    expect(operationRow(h.database, "operation-71")).toMatchObject({
      status: "blocked",
      worker_id: null,
      lease_token: null,
      lease_expires_at: null,
    });
    expect(operationRow(h.database, "operation-72")).toMatchObject({
      status: "blocked",
      worker_id: null,
      lease_token: null,
      lease_expires_at: null,
    });
    const metadata = receiptRow(h.database, "delivery-all-to-selected")?.metadata_json;
    expect(metadata).not.toContain("repository_selection");
    expect(metadata).not.toContain("repositories_removed");
    expect(metadata).not.toContain("rawBody");
  });

  it("rejects unrecognized summary fields while retaining bounded compatibility for old summaries", async () => {
    const h = createHarness();
    seedBinding(h.database, "instance-71", 71, 700);

    const response = await h.routes.request("/internal/github/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Control-Plane-Gateway-Auth": SECRET,
      },
      body: JSON.stringify({ ...webhook({ deliveryId: "delivery-extra-field" }), extra: true }),
    });
    expect(response.status).toBe(400);

    const legacySummary = await h.post(
      webhook({
        deliveryId: "delivery-legacy-empty-removal",
        event: "installation_repositories",
        action: "removed",
        installationId: 700,
        repositoryIds: [],
      }),
    );
    expect(legacySummary.status).toBe(202);
    expect(bindingRow(h.database, 71)).toMatchObject({ binding_epoch: 1, suspended: 0 });
  });

  it("suspends all bindings only for a deleted installation and never unsuspends from a webhook", async () => {
    const h = createHarness();
    seedBinding(h.database, "instance-71", 71, 700);
    seedBinding(h.database, "instance-72", 72, 700);
    seedBinding(h.database, "instance-73", 73, 701);
    seedBinding(h.database, "instance-74", 74, 702);

    const deleted = await h.post(
      webhook({
        deliveryId: "delivery-install-deleted",
        event: "installation",
        action: "deleted",
        installationId: 700,
        repositoryIds: [],
      }),
    );
    expect(deleted.status).toBe(202);
    expect(bindingRow(h.database, 71)).toMatchObject({ binding_epoch: 2, suspended: 1 });
    expect(bindingRow(h.database, 72)).toMatchObject({ binding_epoch: 2, suspended: 1 });
    expect(bindingRow(h.database, 73)).toMatchObject({ binding_epoch: 1, suspended: 0 });

    const suspended = await h.post(
      webhook({
        deliveryId: "delivery-install-suspend",
        event: "installation",
        action: "suspend",
        installationId: 702,
        repositoryIds: [],
      }),
    );
    expect(suspended.status).toBe(202);
    expect(bindingRow(h.database, 74)).toMatchObject({ binding_epoch: 2, suspended: 1 });

    const unsuspend = await h.post(
      webhook({
        deliveryId: "delivery-install-unsuspend",
        event: "installation",
        action: "unsuspend",
        installationId: 700,
        repositoryIds: [],
      }),
    );
    expect(unsuspend.status).toBe(202);
    expect(bindingRow(h.database, 71)).toMatchObject({ binding_epoch: 2, suspended: 1 });
    expect(bindingRow(h.database, 72)).toMatchObject({ binding_epoch: 2, suspended: 1 });
    expect(receiptRow(h.database, "delivery-install-unsuspend")).toBeTruthy();
  });

  it("does not accept a transfer for a repository bound to another installation", async () => {
    const h = createHarness();
    seedBinding(h.database, "instance-71", 71, 700);

    const response = await h.post(
      webhook({
        deliveryId: "delivery-transfer-wrong-install",
        event: "repository",
        action: "transferred",
        installationId: 701,
        repositoryIds: [71],
      }),
    );
    expect(response.status).toBe(202);
    expect(bindingRow(h.database, 71)).toMatchObject({
      installation_id: 700,
      binding_epoch: 1,
      suspended: 0,
    });
    expect(receiptRow(h.database, "delivery-transfer-wrong-install")).toBeTruthy();
  });

  it("suspends a renamed repository binding from its exact repository and installation IDs", async () => {
    const h = createHarness();
    seedBinding(h.database, "instance-71", 71, 700);

    const response = await h.post(
      webhook({
        deliveryId: "delivery-rename-71",
        event: "repository",
        action: "renamed",
        installationId: 700,
        repositoryIds: [71],
      }),
    );
    expect(response.status).toBe(202);
    expect(bindingRow(h.database, 71)).toMatchObject({ binding_epoch: 2, suspended: 1 });
    expect(count(h.database, "github:binding:delivery-rename-71:%")).toBe(1);
  });

  it("requires the private Gateway service secret", async () => {
    const h = createHarness();
    const response = await h.routes.request("/internal/github/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhook({ deliveryId: "unauthorized" })),
    });
    expect(response.status).toBe(401);
  });
});

function createHarness() {
  const database = new DatabaseSync(":memory:");
  liveDatabases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    database.exec(
      readFileSync(fileURLToPath(new URL(`../migrations/${migration}`, import.meta.url)), "utf8"),
    );
  }
  const db = new SQLiteD1Database(database);
  const routes = createGitHubWebhookRoutes({ db, gatewaySecret: SECRET, now: () => 100 });
  return {
    database,
    routes,
    post(delivery: GitHubWebhookDelivery) {
      return routes.request("/internal/github/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Control-Plane-Gateway-Auth": SECRET,
        },
        body: JSON.stringify(delivery),
      });
    },
  };
}

function webhook(
  overrides: Partial<GitHubWebhookDelivery> & Pick<GitHubWebhookDelivery, "deliveryId">,
): GitHubWebhookDelivery {
  return {
    deliveryId: overrides.deliveryId,
    bodyDigest: overrides.bodyDigest ?? "a".repeat(64),
    event: overrides.event ?? "issues",
    action: overrides.action ?? null,
    installationId: overrides.installationId ?? null,
    repositoryIds: overrides.repositoryIds ?? [],
    ...(overrides.repositorySelection === undefined
      ? {}
      : { repositorySelection: overrides.repositorySelection }),
  };
}

function seedBinding(
  database: DatabaseSync,
  instanceId: string,
  repositoryId: number,
  installationId: number,
) {
  database
    .prepare(
      `INSERT INTO logical_instances (instance_id, repository_id, desired_state, created_at, updated_at)
     VALUES (?, ?, 'stopped', 1, 1)`,
    )
    .run(instanceId, repositoryId);
  database
    .prepare(
      `INSERT INTO repository_bindings (
       repository_id, instance_id, installation_id, owner, name,
       authorization_revision, binding_epoch, suspended, created_at, updated_at
     ) VALUES (?, ?, ?, 'praetorium', ?, 3, 1, 0, 1, 1)`,
    )
    .run(repositoryId, instanceId, installationId, `repository-${repositoryId}`);
}

function seedOperation(
  database: DatabaseSync,
  operationId: string,
  instanceId: string,
  repositoryId: number,
  kind: "start" | "stop" | "redeploy" | "update",
  status: "pending" | "claimed" | "running",
) {
  database
    .prepare(
      `INSERT INTO operations (
       operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status,
       worker_id, lease_token, lease_expires_at, idempotency_scope, idempotency_key,
       request_hash, actor_id, authorization_revision, created_at, updated_at
     ) VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, 500, ?, ?, ?, 'user-1', 3, 1, 1)`,
    )
    .run(
      operationId,
      instanceId,
      repositoryId,
      kind,
      status,
      status === "pending" ? null : "worker-1",
      status === "pending" ? null : "lease-token-1",
      `scope-${operationId}`,
      `key-${operationId}`,
      `hash-${operationId}`,
    );
}

function bindingRow(
  database: DatabaseSync,
  repositoryId: number,
): Record<string, unknown> | undefined {
  return database
    .prepare("SELECT * FROM repository_bindings WHERE repository_id = ?")
    .get(repositoryId) as Record<string, unknown> | undefined;
}

function operationRow(
  database: DatabaseSync,
  operationId: string,
): Record<string, unknown> | undefined {
  return database.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId) as
    | Record<string, unknown>
    | undefined;
}

function receiptRow(
  database: DatabaseSync,
  deliveryId: string,
): Record<string, unknown> | undefined {
  return database
    .prepare("SELECT * FROM audit_events WHERE event_id = ?")
    .get(`github:delivery:${deliveryId}`) as Record<string, unknown> | undefined;
}

function count(database: DatabaseSync, eventIdPattern: string): number {
  const row = database
    .prepare("SELECT count(*) AS count FROM audit_events WHERE event_id LIKE ?")
    .get(eventIdPattern) as {
    count: number;
  };
  return row.count;
}

async function signedGitHubHeaders(rawBody: Uint8Array, deliveryId: string): Promise<Headers> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(GITHUB_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const body = new Uint8Array(rawBody.byteLength);
  body.set(rawBody);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, body.buffer));
  const hex = [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Headers({
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${hex}`,
    "X-GitHub-Delivery": deliveryId,
    "X-GitHub-Event": "installation_repositories",
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
      for (const statement of statements)
        results.push(await (statement as SQLiteD1Statement).run<T>());
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
