import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertKindRuntimeVersion,
  KIND_RUNTIME_VERSION,
  NODE_IMAGE,
} from "../../infrastructure/scripts/kind-runtime.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = readFileSync(
  path.join(repoRoot, "infrastructure/kind/disposable-config.yaml"),
  "utf8",
);

test("pins the official Kind v0.31.0 node image with a digest", () => {
  assert.equal(KIND_RUNTIME_VERSION, "v0.31.0");
  assert.equal(
    NODE_IMAGE,
    "kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f",
  );
  assert.ok(config.split(/\r?\n/u).includes(`    image: ${NODE_IMAGE}`));
});

test("requires the exact Kind CLI version for the disposable default network", () => {
  assert.equal(assertKindRuntimeVersion("kind v0.31.0 go1.26.3 linux/amd64"), KIND_RUNTIME_VERSION);

  for (const output of [
    "kind v0.30.0 go1.25.0 linux/amd64",
    "kind v0.31.1 go1.26.3 linux/amd64",
    "kind v0.31.0-rc.1 go1.26.3 linux/amd64",
    "v0.31.0",
    "",
    null,
  ]) {
    assert.throws(() => assertKindRuntimeVersion(output), /Kind runtime/u);
  }
});

test("keeps Kind's default network and the disposable ownership labels", () => {
  assert.match(config, /^kind: Cluster$/mu);
  assert.match(config, /^\s+- role: control-plane$/mu);
  assert.match(config, /"praetorium\.io\/cluster-id": "@@CLUSTER_ID@@"/u);
  assert.match(config, /"praetorium\.io\/disposable": "true"/u);
  assert.doesNotMatch(config, /disableDefaultCNI\s*:\s*true/u);
});

test("create rejects an unsupported CLI before invoking Kind create or writing a kubeconfig", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "praetorium-kind-version-"));
  try {
    const kind = path.join(temporary, "kind");
    const kubectl = path.join(temporary, "kubectl");
    const calls = path.join(temporary, "calls");
    writeFileSync(
      kind,
      `#!/bin/sh\nif [ "$1" = "version" ] || [ "$1" = "--version" ]; then echo 'kind v0.30.0 go1.25.0 linux/amd64'; else echo unexpected >> '${calls}'; exit 1; fi\n`,
      { mode: 0o700 },
    );
    writeFileSync(kubectl, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const result = spawnSync(
      process.execPath,
      [
        "scripts/deploy-infrastructure.mjs",
        "create",
        "--inventory",
        "infrastructure/test/disposable-inventory.json",
        "--confirm",
        "praetorium-t12-local",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, PRAETORIUM_KIND_BIN: kind, PRAETORIUM_KUBECTL_BIN: kubectl },
      },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Kind runtime v0.30.0 is unsupported/);
    assert.throws(() => readFileSync(calls), { code: "ENOENT" });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
