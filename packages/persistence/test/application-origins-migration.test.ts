import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const binding = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const migration = readFileSync(
  new URL("../../../apps/control-plane/migrations/0006_application_origins.sql", import.meta.url),
  "utf8",
);
function source(status: "succeeded" | "running") {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL(
        "../../../apps/control-plane/migrations/0001_repository_platform.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  db.prepare(
    `INSERT INTO logical_instances(instance_id, repository_id, desired_state, runtime_epoch, observed_runtime_epoch, observed_state, created_at, updated_at) VALUES (?,482901,'running',4,4,'ready',1,2)`,
  ).run(binding);
  db.prepare(
    `INSERT INTO repository_bindings(repository_id,instance_id,installation_id,owner,name,created_at,updated_at) VALUES (482901,?,83104,'owner','book',1,2)`,
  ).run(binding);
  db.prepare(
    `INSERT INTO operations(operation_id,instance_id,repository_id,generation,runtime_epoch,kind,status,idempotency_scope,idempotency_key,request_hash,actor_id,authorization_revision,created_at,updated_at) VALUES ('operation-history',?,482901,1,4,'start',?,'repository:482901','original-key','original-hash','user',1,1,2)`,
  ).run(binding, status);
  return db;
}

describe("application binding migration", () => {
  it("preserves logical history and the exact source writer identity without deleting data", () => {
    const db = source("succeeded");
    try {
      const before = db.prepare("SELECT * FROM operations").all();
      db.exec(migration);
      expect(db.prepare("SELECT * FROM operations").all()).toEqual(before);
      expect(db.prepare("SELECT * FROM application_bindings").get()).toMatchObject({
        app_identity: "scriptorium",
        repository_id: 482901,
        binding_id: binding,
        instance_id: binding,
        runtime_epoch: 4,
      });
      expect(db.prepare("SELECT legacy_runtime_epoch FROM logical_instances").get()).toMatchObject({
        legacy_runtime_epoch: 4,
      });
      db.exec("UPDATE logical_instances SET runtime_epoch=5, observed_runtime_epoch=5");
      expect(db.prepare("SELECT * FROM application_bindings").get()).toMatchObject({
        binding_id: binding,
        instance_id: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV_5",
      });
      db.exec("UPDATE logical_instances SET runtime_epoch=6, observed_runtime_epoch=6");
      expect(db.prepare("SELECT instance_id FROM application_bindings").get()).toMatchObject({
        instance_id: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV_6",
      });
    } finally {
      db.close();
    }
  });
  it("refuses migration over an active lifecycle operation", () => {
    const db = source("running");
    try {
      expect(() => db.exec(migration)).toThrow(/CHECK constraint/);
      expect(db.prepare("SELECT status FROM operations").get()).toMatchObject({
        status: "running",
      });
      expect(
        db
          .prepare("PRAGMA table_info(logical_instances)")
          .all()
          .some((row) => row.name === "legacy_runtime_epoch"),
      ).toBe(false);
    } finally {
      db.close();
    }
  });
});
