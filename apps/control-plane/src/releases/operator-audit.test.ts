import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import type { D1Database } from "@praetorium/persistence/d1";
import { parseAuditCursor, readOperatorAudit } from "./operator-audit.js";

describe("operator audit readback", () => {
  it("pages tied timestamps without loss, includes source outcomes and bounds search", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE audit_events(event_id TEXT PRIMARY KEY,actor_id TEXT,action TEXT,outcome TEXT,occurred_at INTEGER,request_id TEXT,metadata_json TEXT NOT NULL)");
    const insert = sqlite.prepare("INSERT INTO audit_events VALUES (?,?,?,?,?,?,?)");
    for (let index = 0; index < 30; index++) insert.run("event:" + index.toString().padStart(2, "0"), "71",
      index % 2 ? "source-release-build.failed" : "release.candidate.admitted", "accepted", 123,
      index % 2 ? "sr_730c616f-329c-4d2f-aabb-d143eaa2db01" : null,
      index % 2 ? JSON.stringify({ failureCode: "SOURCE_BUILD_FAILED", leaseEpoch: index }) : "{}");
    insert.run("tenant", "71", "repository.secret-event", "accepted", 124, null, "{}");
    const db = { prepare: (sql: string) => ({ bind: (...values: (string | number | null)[]) => ({
      all: async () => ({ results: sqlite.prepare(sql).all(...values), meta: { changes: 0 } }),
    }) }) } as unknown as D1Database;
    try {
      const first = await readOperatorAudit(db, { cursor: null, query: "" });
      const second = await readOperatorAudit(db, { cursor: first.nextCursor, query: "" });
      expect(first.events).toHaveLength(25);
      expect(second.events).toHaveLength(5);
      expect(first.nextCursor).toBe("123:event:05");
      expect(second.nextCursor).toBeNull();
      expect([...first.events, ...second.events].every(event => !event.action.startsWith("repository"))).toBe(true);
      const failures = await readOperatorAudit(db, { cursor: null, query: "FAILED" });
      expect(failures.events).toHaveLength(15);
      expect(failures.events.every(event => event.action === "source-release-build.failed")).toBe(true);
      const byJob = await readOperatorAudit(db, { cursor: null, query: "sr_730c616f-329c-4d2f-aabb-d143eaa2db01" });
      expect(byJob.events).toHaveLength(15);
      expect(byJob.events.every(event => event.jobId === "sr_730c616f-329c-4d2f-aabb-d143eaa2db01")).toBe(true);
      expect(byJob.events.every(event => event.failureCode === "SOURCE_BUILD_FAILED")).toBe(true);
      expect((await readOperatorAudit(db, { cursor: null, query: "' OR 1=1" })).events).toHaveLength(0);
      await expect(readOperatorAudit(db, { cursor: null, query: "x".repeat(101) })).rejects.toThrow("Invalid audit search");
      expect(() => parseAuditCursor("123:../../secrets")).toThrow("Invalid audit cursor");
      expect(() => parseAuditCursor("9007199254740992:valid")).toThrow("Invalid audit cursor");
    } finally { sqlite.close(); }
  });
});
