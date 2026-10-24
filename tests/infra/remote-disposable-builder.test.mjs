import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/remote-disposable-builder.sh");
const source = readFileSync(script, "utf8");

test("remote Builder helper is syntax-valid and offers only explicit bounded actions", () => {
  const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(source, /\$action == plan \|\| \$action == setup \|\| \$action == cleanup/u);
  assert.match(source, /IMAGE_BYTES=6442450944/u);
  assert.match(source, /CPUQuota=200%[\s\S]*MemoryMax=4G[\s\S]*TasksMax=2048/u);
  assert.match(source, /BuildKit=10\.7\.0\.32:1235/u);
});

test("remote Builder helper isolates state and leaves production BuildKit protected", () => {
  assert.match(source, /podman version 5\.7\.0/u);
  assert.match(source, /kind v0\.31\.0/u);
  assert.match(source, /v1\.35\.0/u);
  assert.match(source, /graphroot = "\$MOUNT\/podman\/graphroot/u);
  assert.match(source, /systemctl is-active praetorium-buildkit\.service/u);
  assert.match(source, /10\\\.7\\\.0\\\.32:1234/u);
  assert.doesNotMatch(source, /systemctl\s+(?:stop|restart|disable)\s+praetorium-buildkit\.service/u);
  assert.doesNotMatch(source, /podman\s+system\s+reset|kind\s+delete\s+clusters/u);
  assert.match(source, /verify_marker[\s\S]*cmp -s "\$MARKER" "\$MOUNT\//u);
  assert.match(source, /KIND_EXPERIMENTAL_PROVIDER=podman kind delete cluster --name "\$CLUSTER"/u);
});

