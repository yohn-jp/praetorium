import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  HISTORY_MARKER_NODE_SCRIPT,
  HISTORY_RESTORE_NODE_SCRIPT,
  parseHistorySnapshot,
} from "../src/kubernetes/history.js";

function snapshot(path: string, contents: string, sourcePodUid = "pod-1"): string {
  const bytes = Buffer.from(contents, "utf8");
  const files = [
    {
      path,
      contentBase64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ];
  const canonical = JSON.stringify({ schemaVersion: 1, sourcePodUid, files });
  return JSON.stringify({
    schemaVersion: 1,
    sourcePodUid,
    files,
    manifestSha256: createHash("sha256").update(canonical).digest("hex"),
  });
}

describe("private history snapshot validation", () => {
  it("accepts a canonical bounded regular-file manifest", () => {
    expect(parseHistorySnapshot(snapshot("activity/recent.json", "{}"), "pod-1")).toMatchObject({
      schemaVersion: 1,
      sourcePodUid: "pod-1",
      files: [{ path: "activity/recent.json" }],
    });
  });

  it.each(["../outside", "/absolute", "a\\b", ".praetorium-initialized", "nested//empty"]) (
    "rejects unsafe path %s",
    (path) => {
      expect(() => parseHistorySnapshot(snapshot(path, "{}"), "pod-1")).toThrow();
    },
  );

  it("rejects source UID drift and tampered content", () => {
    expect(() => parseHistorySnapshot(snapshot("a.json", "{}"), "pod-2")).toThrow();
    const tampered = JSON.parse(snapshot("a.json", "{}")) as {
      files: Array<{ contentBase64: string }>;
    };
    tampered.files[0]!.contentBase64 = Buffer.from("changed").toString("base64");
    expect(() => parseHistorySnapshot(JSON.stringify(tampered), "pod-1")).toThrow();
  });

  it("uses a private data subdirectory and reapplies owner-only modes on every init run", () => {
    expect(HISTORY_RESTORE_NODE_SCRIPT).toContain("const privateRoot = path.join(root, 'private')");
    expect(HISTORY_RESTORE_NODE_SCRIPT).toContain("fs.chmodSync(privateRoot, 0o700)");
    expect(HISTORY_RESTORE_NODE_SCRIPT).toContain("fs.chmodSync(target, 0o600)");
    expect(HISTORY_RESTORE_NODE_SCRIPT).toContain("enforcePrivateModes(privateRoot)");
    expect(HISTORY_MARKER_NODE_SCRIPT).toContain("/history/private");
    expect(HISTORY_MARKER_NODE_SCRIPT).toContain("0o700");
    expect(HISTORY_MARKER_NODE_SCRIPT).toContain("0o600");
  });

  it("reapplies private modes on a marked PVC restart without overwriting later history", () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "praetorium-history-"));
    try {
      const historyRoot = path.join(temporary, "history");
      const privateRoot = path.join(historyRoot, "private");
      const seedRoot = path.join(temporary, "seed");
      const seedPath = path.join(seedRoot, "snapshot.json");
      mkdirSync(historyRoot);
      mkdirSync(seedRoot);
      writeFileSync(seedPath, snapshot("activity/recent.json", "seeded"));
      const script = HISTORY_RESTORE_NODE_SCRIPT
        .replace("const root = '/history';", `const root = ${JSON.stringify(historyRoot)};`)
        .replace("const seedPath = '/history-seed/snapshot.json';", `const seedPath = ${JSON.stringify(seedPath)};`);
      const environment = {
        ...process.env,
        PRAETORIUM_HISTORY_INSTANCE_ID: "ins_00000000000000000000000001",
        PRAETORIUM_HISTORY_REPOSITORY_ID: "731",
        PRAETORIUM_HISTORY_CLUSTER_ID: "clu_00000000000000000000000001",
        PRAETORIUM_HISTORY_CLAIM_NAME: "arcadia-ins-00000000000000000000000001-history",
      };
      const runInit = () => spawnSync(process.execPath, ["-e", script], { env: environment });
      const first = runInit();
      expect(first.status, first.stderr.toString()).toBe(0);
      const recent = path.join(privateRoot, "activity", "recent.json");
      expect(readFileSync(recent, "utf8")).toBe("seeded");
      expect(statSync(privateRoot).mode & 0o777).toBe(0o700);
      expect(statSync(path.dirname(recent)).mode & 0o777).toBe(0o700);
      expect(statSync(recent).mode & 0o777).toBe(0o600);

      writeFileSync(recent, "later runtime history");
      chmodSync(privateRoot, 0o770);
      chmodSync(path.dirname(recent), 0o770);
      chmodSync(recent, 0o664);
      const second = runInit();
      expect(second.status, second.stderr.toString()).toBe(0);
      expect(readFileSync(recent, "utf8")).toBe("later runtime history");
      expect(statSync(privateRoot).mode & 0o777).toBe(0o700);
      expect(statSync(path.dirname(recent)).mode & 0o777).toBe(0o700);
      expect(statSync(recent).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
