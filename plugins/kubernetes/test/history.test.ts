import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  HISTORY_MARKER_NODE_SCRIPT,
  HISTORY_RESTORE_NODE_SCRIPT,
  HISTORY_SNAPSHOT_NODE_SCRIPT,
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

  it("fsyncs restored files and directories bottom-up before publishing completion", () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "praetorium-history-fsync-"));
    try {
      const historyRoot = path.join(temporary, "history");
      const privateRoot = path.join(historyRoot, "private");
      const seedRoot = path.join(temporary, "seed");
      const seedPath = path.join(seedRoot, "snapshot.json");
      const orderPath = path.join(temporary, "fsync-order.json");
      mkdirSync(historyRoot);
      mkdirSync(seedRoot);
      writeFileSync(seedPath, snapshot("activity/session/recent.json", "seeded"));
      const wrapped = `
        ;(() => {
          const fs = require('node:fs');
          const path = require('node:path');
          const events = [];
          const descriptors = new Map();
          const open = fs.openSync;
          const sync = fs.fsyncSync;
          const close = fs.closeSync;
          const unlink = fs.unlinkSync;
          const write = fs.writeFileSync;
          fs.openSync = (file, ...args) => { const fd = open.call(fs, file, ...args); descriptors.set(fd, path.resolve(String(file))); return fd; };
          fs.fsyncSync = fd => { events.push('fsync:' + descriptors.get(fd)); return sync.call(fs, fd); };
          fs.closeSync = fd => { descriptors.delete(fd); return close.call(fs, fd); };
          fs.unlinkSync = file => { events.push('unlink:' + path.resolve(file)); return unlink.call(fs, file); };
          process.on('exit', () => write.call(fs, ${JSON.stringify(orderPath)}, JSON.stringify(events)));
        })();
      `;
      const script = (wrapped + HISTORY_RESTORE_NODE_SCRIPT)
        .replace("const root = '/history';", `const root = ${JSON.stringify(historyRoot)};`)
        .replace("const seedPath = '/history-seed/snapshot.json';", `const seedPath = ${JSON.stringify(seedPath)};`);
      const result = spawnSync(process.execPath, ["-e", script], {
        env: {
          ...process.env,
          PRAETORIUM_HISTORY_INSTANCE_ID: "ins_00000000000000000000000001",
          PRAETORIUM_HISTORY_REPOSITORY_ID: "731",
          PRAETORIUM_HISTORY_CLUSTER_ID: "clu_00000000000000000000000001",
          PRAETORIUM_HISTORY_CLAIM_NAME: "arcadia-ins-00000000000000000000000001-history",
        },
      });
      expect(result.status, result.stderr.toString()).toBe(0);
      const events = JSON.parse(readFileSync(orderPath, "utf8")) as string[];
      const index = (entry: string, from = 0) => events.findIndex((value, position) => position >= from && value === entry);
      const file = path.join(privateRoot, "activity", "session", "recent.json");
      const fileSync = index(`fsync:${file}`);
      const sessionSync = index(`fsync:${path.dirname(file)}`);
      const activitySync = index(`fsync:${path.dirname(path.dirname(file))}`);
      const privateSync = index(`fsync:${privateRoot}`, activitySync + 1);
      const markerSync = index(`fsync:${path.join(historyRoot, ".praetorium-initialized")}`);
      const rootAfterMarker = index(`fsync:${historyRoot}`, markerSync + 1);
      const progressUnlink = index(`unlink:${path.join(historyRoot, ".praetorium-restore-in-progress")}`);
      const rootAfterUnlink = index(`fsync:${historyRoot}`, progressUnlink + 1);
      expect(fileSync).toBeGreaterThanOrEqual(0);
      expect(sessionSync).toBeGreaterThan(fileSync);
      expect(activitySync).toBeGreaterThan(sessionSync);
      expect(privateSync).toBeGreaterThan(activitySync);
      expect(markerSync).toBeGreaterThan(privateSync);
      expect(rootAfterMarker).toBeGreaterThan(markerSync);
      expect(progressUnlink).toBeGreaterThan(rootAfterMarker);
      expect(rootAfterUnlink).toBeGreaterThan(progressUnlink);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("resumes a matching partial restore and bounds source history traversal", () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "praetorium-history-resume-"));
    try {
      const historyRoot = path.join(temporary, "history");
      const privateRoot = path.join(historyRoot, "private");
      const seedRoot = path.join(temporary, "seed");
      const seedPath = path.join(seedRoot, "snapshot.json");
      mkdirSync(privateRoot, { recursive: true });
      mkdirSync(seedRoot);
      const seedText = snapshot("activity/session/recent.json", "seeded");
      const seed = JSON.parse(seedText) as { manifestSha256: string };
      writeFileSync(seedPath, seedText);
      mkdirSync(path.join(privateRoot, "activity", "session"), { recursive: true });
      writeFileSync(path.join(privateRoot, "activity", "session", "recent.json"), "seeded");
      writeFileSync(path.join(historyRoot, ".praetorium-restore-in-progress"), JSON.stringify({
        schemaVersion: 1,
        instanceId: "ins_00000000000000000000000001",
        repositoryId: "731",
        clusterId: "clu_00000000000000000000000001",
        claimName: "arcadia-ins-00000000000000000000000001-history",
        seedManifestSha256: seed.manifestSha256,
      }));
      const script = HISTORY_RESTORE_NODE_SCRIPT
        .replace("const root = '/history';", `const root = ${JSON.stringify(historyRoot)};`)
        .replace("const seedPath = '/history-seed/snapshot.json';", `const seedPath = ${JSON.stringify(seedPath)};`);
      const resumed = spawnSync(process.execPath, ["-e", script], {
        env: {
          ...process.env,
          PRAETORIUM_HISTORY_INSTANCE_ID: "ins_00000000000000000000000001",
          PRAETORIUM_HISTORY_REPOSITORY_ID: "731",
          PRAETORIUM_HISTORY_CLUSTER_ID: "clu_00000000000000000000000001",
          PRAETORIUM_HISTORY_CLAIM_NAME: "arcadia-ins-00000000000000000000000001-history",
        },
      });
      expect(resumed.status, resumed.stderr.toString()).toBe(0);
      expect(readFileSync(path.join(privateRoot, "activity", "session", "recent.json"), "utf8")).toBe("seeded");
      expect(statSync(path.join(privateRoot, "activity", "session", "recent.json")).mode & 0o777).toBe(0o600);

      const source = path.join(temporary, "legacy-history");
      mkdirSync(source);
      for (let index = 0; index < 4_097; index += 1) writeFileSync(path.join(source, `entry-${index}.json`), "");
      const snapshotScript = HISTORY_SNAPSHOT_NODE_SCRIPT
        .replace("const root = process.argv[1];", `const root = ${JSON.stringify(source)};`)
        .replace("if (root !== '/data/history') throw new Error('invalid source path');", `if (root !== ${JSON.stringify(source)}) throw new Error('invalid source path');`);
      const oversized = spawnSync(process.execPath, ["-e", snapshotScript, source, "pod-1"]);
      expect(oversized.status).not.toBe(0);
      expect(oversized.stdout.length).toBe(0);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("fails closed on an oversized current private tree", () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "praetorium-history-tree-limit-"));
    try {
      const historyRoot = path.join(temporary, "history");
      const privateRoot = path.join(historyRoot, "private");
      mkdirSync(privateRoot, { recursive: true });
      writeFileSync(path.join(historyRoot, ".praetorium-initialized"), JSON.stringify({
        schemaVersion: 1,
        instanceId: "ins_00000000000000000000000001",
        repositoryId: "731",
        clusterId: "clu_00000000000000000000000001",
        claimName: "arcadia-ins-00000000000000000000000001-history",
        seedManifestSha256: "a".repeat(64),
      }));
      for (let index = 0; index < 4_097; index += 1)
        writeFileSync(path.join(privateRoot, `entry-${index}.json`), "");
      const script = HISTORY_RESTORE_NODE_SCRIPT.replace(
        "const root = '/history';",
        `const root = ${JSON.stringify(historyRoot)};`,
      );
      const result = spawnSync(process.execPath, ["-e", script], {
        env: {
          ...process.env,
          PRAETORIUM_HISTORY_INSTANCE_ID: "ins_00000000000000000000000001",
          PRAETORIUM_HISTORY_REPOSITORY_ID: "731",
          PRAETORIUM_HISTORY_CLUSTER_ID: "clu_00000000000000000000000001",
          PRAETORIUM_HISTORY_CLAIM_NAME: "arcadia-ins-00000000000000000000000001-history",
        },
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout.length).toBe(0);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("fails closed before walking a too-deep current private tree", () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "praetorium-history-depth-limit-"));
    try {
      const historyRoot = path.join(temporary, "history");
      const privateRoot = path.join(historyRoot, "private");
      mkdirSync(privateRoot, { recursive: true });
      let deep = privateRoot;
      for (let index = 0; index < 17; index += 1) {
        deep = path.join(deep, `d${index}`);
        mkdirSync(deep);
      }
      writeFileSync(path.join(historyRoot, ".praetorium-initialized"), JSON.stringify({
        schemaVersion: 1,
        instanceId: "ins_00000000000000000000000001",
        repositoryId: "731",
        clusterId: "clu_00000000000000000000000001",
        claimName: "arcadia-ins-00000000000000000000000001-history",
        seedManifestSha256: "a".repeat(64),
      }));
      const script = HISTORY_RESTORE_NODE_SCRIPT.replace(
        "const root = '/history';",
        `const root = ${JSON.stringify(historyRoot)};`,
      );
      const result = spawnSync(process.execPath, ["-e", script], {
        env: {
          ...process.env,
          PRAETORIUM_HISTORY_INSTANCE_ID: "ins_00000000000000000000000001",
          PRAETORIUM_HISTORY_REPOSITORY_ID: "731",
          PRAETORIUM_HISTORY_CLUSTER_ID: "clu_00000000000000000000000001",
          PRAETORIUM_HISTORY_CLAIM_NAME: "arcadia-ins-00000000000000000000000001-history",
        },
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout.length).toBe(0);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
