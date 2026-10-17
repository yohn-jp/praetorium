import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
