import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  BUILDER_OWNER,
  createCgroupReceipt,
  createBuilderJournal,
  createOwnerMarker,
  renderMountUnit,
  renderSliceUnit,
  validateBuilderJournal,
  validateCgroupReceipt,
  validateOwnerMarker,
  writeOwnerMarker,
} from "../../scripts/remote-disposable-builder-state.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/remote-disposable-builder.sh");
const source = readFileSync(script, "utf8");

test("remote Builder helper is syntax-valid and offers only explicit bounded actions", () => {
  const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(source, /\$action == plan \|\| \$action == setup \|\| \$action == run/u);
  assert.match(source, /IMAGE_BYTES=6442450944/u);
  assert.match(renderSliceUnit(), /CPUQuota=200%[\s\S]*MemoryMax=4G[\s\S]*TasksMax=2048/u);
  assert.match(source, /testport=10\.7\.0\.32:1235/u);
});

test("remote Builder helper isolates state and leaves production BuildKit protected", () => {
  assert.match(source, /podman version 5\.7\.0/u);
  assert.match(source, /kind v0\.31\.0/u);
  assert.match(source, /v1\.35\.0/u);
  assert.match(source, /graphroot = "\$MOUNT\/podman\/graphroot/u);
  assert.match(source, /systemctl is-active praetorium-buildkit\.service/u);
  assert.match(source, /10\\\.7\\\.0\\\.32:1234/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:stop|restart|disable)\s+praetorium-buildkit\.service/u,
  );
  assert.doesNotMatch(source, /podman\s+system\s+reset|kind\s+delete\s+clusters/u);
  assert.match(source, /verify_marker[\s\S]*cmp -s "\$MARKER" "\$MOUNT\//u);
  assert.match(source, /KIND_EXPERIMENTAL_PROVIDER=podman kind delete cluster --name "\$CLUSTER"/u);
  assert.match(source, /journal-init[\s\S]*journal-stage[\s\S]*journal-remove/u);
  assert.match(source, /useradd --system --user-group/u);
  assert.match(source, /runuser --login --user/u);
  assert.doesNotMatch(source, /\bHOME=/u);
  assert.doesNotMatch(source, /Delegate=yes[\s\S]*\[Slice\]/u);
});

test("T14 marker serializes and parses the escaped mount unit as valid JSON", () => {
  const marker = createOwnerMarker({
    filesystemUuid: "01234567-89ab-cdef-0123-456789abcdef",
    mountUnitSha256: "a".repeat(64),
    sliceUnitSha256: "b".repeat(64),
    ownerUid: 2000,
    ownerGid: 2000,
    now: new Date("2026-10-25T00:00:00.000Z"),
  });
  const serialized = JSON.stringify(marker);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.mountUnit, "var-lib-praetorium\\x2dt14-state.mount");
  assert.equal(validateOwnerMarker(parsed), parsed);
  assert.throws(
    () => JSON.parse('{"mountUnit":"var-lib-praetorium\\x2dt14-state.mount"}'),
    SyntaxError,
  );
});

test("owner marker writer emits valid private JSON and setup journal is durably initialized", async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "praetorium-t14-marker-"));
  try {
    const markerPath = path.join(temporary, "owner.json");
    const marker = createOwnerMarker({
      filesystemUuid: "01234567-89ab-cdef-0123-456789abcdef",
      mountUnitSha256: "a".repeat(64),
      sliceUnitSha256: "b".repeat(64),
      ownerUid: 2000,
      ownerGid: 2000,
    });
    await writeOwnerMarker(markerPath, marker);
    assert.equal(
      validateOwnerMarker(JSON.parse(readFileSync(markerPath, "utf8"))).mountUnit,
      BUILDER_OWNER.mountUnit,
    );
    assert.equal(statSync(markerPath).mode & 0o777, 0o600);

    const journalPath = path.join(temporary, "setup-journal.json");
    const journal = spawnSync(
      process.execPath,
      [path.join(root, "scripts/remote-disposable-builder-state.mjs"), "journal-init", journalPath],
      { encoding: "utf8" },
    );
    assert.equal(journal.status, 0, journal.stderr);
    assert.equal(
      validateBuilderJournal(JSON.parse(readFileSync(journalPath, "utf8"))).stage,
      "reserved",
    );
    assert.equal(statSync(journalPath).mode & 0o777, 0o600);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("setup journal has a validated forward-only recovery lifecycle", () => {
  const reserved = createBuilderJournal();
  assert.equal(validateBuilderJournal(reserved), reserved);
  const mounted = {
    ...reserved,
    stage: "mounted",
    uid: 2000,
    gid: 2000,
    filesystemUuid: "01234567-89ab-cdef-0123-456789abcdef",
  };
  assert.equal(validateBuilderJournal(mounted).stage, "mounted");
  assert.equal(validateBuilderJournal({ ...mounted, stage: "ready" }).stage, "ready");
  assert.throws(() => validateBuilderJournal({ ...reserved, stage: "unknown" }), /stage/u);
  assert.throws(() => validateBuilderJournal({ ...reserved, owner: "buildkit" }), /owner/u);
});

test("only a fresh readback of the live T14 cgroup limits authorizes bounded run", () => {
  const receipt = createCgroupReceipt({ ownerUid: 2000, sliceUnitSha256: "c".repeat(64) });
  assert.equal(
    validateCgroupReceipt(receipt, { ownerUid: 2000, sliceUnitSha256: "c".repeat(64) }),
    receipt,
  );
  assert.throws(
    () => validateCgroupReceipt(receipt, { ownerUid: 2001, sliceUnitSha256: "c".repeat(64) }),
    /owner UID/u,
  );
  assert.throws(() => validateCgroupReceipt({ ...receipt, memoryMax: "max" }), /memoryMax/u);
  const stale = createCgroupReceipt({
    ownerUid: 2000,
    sliceUnitSha256: "c".repeat(64),
    now: new Date(Date.now() - 2 * 60 * 60 * 1000),
  });
  assert.throws(() => validateCgroupReceipt(stale), /stale/u);
});

test("rendered mount and resource-limit slice units pass systemd syntax verification", (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "praetorium-t14-units-"));
  try {
    const mountPath = path.join(temporary, BUILDER_OWNER.mountUnit);
    const slicePath = path.join(temporary, BUILDER_OWNER.sliceUnit);
    writeFileSync(mountPath, renderMountUnit(), { mode: 0o600 });
    writeFileSync(slicePath, renderSliceUnit(), { mode: 0o600 });
    assert.match(renderMountUnit(), /Options=loop,nodev,nosuid/u);
    assert.match(renderSliceUnit(), /CPUQuota=200%[\s\S]*MemoryMax=4G[\s\S]*TasksMax=2048/u);
    const verify = spawnSync("systemd-analyze", ["verify", mountPath, slicePath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (verify.error?.code === "ENOENT") return t.skip("systemd-analyze unavailable");
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
