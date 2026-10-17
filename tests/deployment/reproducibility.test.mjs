import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateInventory } from "../../infrastructure/scripts/inventory.mjs";
import { renderWorkerTemplate } from "../../infrastructure/scripts/worker-config.mjs";
import { renderPlatformBundle } from "../../infrastructure/scripts/render-platform.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const json = (p) => JSON.parse(readFileSync(path.join(root, p), "utf8"));

test("disposable Kind baseline remains a valid inventory", () => {
  const source = json("infrastructure/test/disposable-inventory.json");
  assert.deepEqual(validateInventory(source).errors, []);
  assert.equal(source.ownership.provider, "kind");
});

test("K3s deployment inventory has a distinct, fail-closed authority", () => {
  const source = json("infrastructure/test/disposable-inventory.json");
  const k3s = structuredClone(source);
  k3s.environment = "deployment";
  k3s.ownership = { provider: "k3s", clusterName: "praetorium-runtime",
    context: "praetorium-runtime", disposable: false, confirmation: "praetorium-runtime" };
  k3s.cloudflare = { mode: "remote", accountId: "1234567890abcdef1234567890abcdef",
    controlPlaneDatabaseId: "08f29fef-eb9e-4541-82fb-777fa2f4aab0",
    gatewayKvNamespaceId: "770c4ac60df74b019409c1203f35687d" };
  assert.ok(!validateInventory(k3s).errors.some((error) =>
    /ownership\.provider|cloudflare\.mode|ownership\.disposable/.test(error)));
  k3s.ownership.provider = "kind";
  assert.ok(validateInventory(k3s).errors.length > 0);
  assert.throws(() => renderPlatformBundle(k3s, {
    overlay: "deployment", buildKustomize: () => "",
  }), /requires deployment environment and k3s ownership/);
});

test("worker template uses the same inventory source for both endpoints", () => {
  const inventory = json("infrastructure/test/disposable-inventory.json");
  const template = readFileSync(path.join(root, "infrastructure/workers/control-plane.template.json"), "utf8");
  const projected = JSON.parse(renderWorkerTemplate(template, inventory, "control-plane"));
  assert.equal(projected.vars.PROVISIONER_CLUSTER_ID, inventory.clusterId);
  assert.equal(projected.vars.PROVISIONER_WORKER_ID, inventory.clusterId + "-provisioner");
  assert.equal(projected.d1_databases[0].binding, "CONTROL_PLANE_DB");
});

test("new commands have valid Node or Bash syntax without remote effects", () => {
  const scripts = [
    "scripts/deploy-k3s.mjs", "scripts/deploy-cloudflare.mjs",
    "scripts/deploy-platform.mjs", "scripts/deploy-workers.mjs",
    "scripts/deploy-infrastructure.mjs", "infrastructure/scripts/render-platform.mjs",
    "infrastructure/scripts/worker-config.mjs", "infrastructure/scripts/inventory.mjs",
  ];
  for (const script of scripts) {
    const result = spawnSync(process.execPath, ["--check", path.join(root, script)], { encoding: "utf8" });
    assert.equal(result.status, 0, script + ": " + result.stderr);
  }
  if (process.platform !== "win32") {
    const result = spawnSync("bash", ["-n", path.join(root, "scripts/bootstrap-linux.sh")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("examples are incomplete and never silently production-applicable", () => {
  const template = json("infrastructure/deployment/inventory.example.json");
  const result = validateInventory(template);
  assert.ok(result.errors.length + result.blockers.length > 0);
  assert.equal(template.ownership.provider, "k3s");
  assert.equal(template.ownership.disposable, false);
  const secretFiles = json("infrastructure/deployment/secret-files.example.json");
  assert.equal(secretFiles.apiVersion, "praetorium.io/secret-files/v1");
  assert.ok(Object.keys(secretFiles.values).includes("buildkitClient"));
});
