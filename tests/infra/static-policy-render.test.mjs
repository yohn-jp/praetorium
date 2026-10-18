import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateInventory } from "../../infrastructure/scripts/inventory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceInventory = path.join(root, "infrastructure/test/disposable-inventory.json");
const kustomize = spawnSync("kustomize", ["version"], { encoding: "utf8" });

// Deliberately synthetic, render-only locators/digests. Nothing is provisioned or pulled.
function renderInventory() {
  const value = JSON.parse(readFileSync(sourceInventory, "utf8"));
  Object.assign(value.domains, {
    gatewayOrigin: "https://gateway.render-only.test",
    gatewayServiceUrl: "http://10.0.1.4:8080",
    controlPlaneUrl: "https://10.0.1.3:8443",
  });
  value.network = {
    kubernetesApiEndpoints: [
      { address: "10.96.0.1", port: 443 },
      { address: "10.0.1.2", port: 6443 },
    ],
    controlPlaneCidrs: ["10.0.1.3/32"],
    gatewayServiceCidrs: ["10.0.1.4/32"],
  };
  Object.assign(value.gateway, {
    allowedRepositoryOwner: "praetorium-render",
    githubAppId: 42,
    githubOauthClientId: "render-client",
    tokenEncryptionKeyId: "render-key",
  });
  Object.assign(value.buildkit, {
    endpoint: "tcp://buildkit.render-only.internal:1234",
    allowedClientCidrs: ["10.0.2.0/24"],
    frontendRepository: "ghcr.io/praetorium-render/build-inputs",
    outputRepository: "ghcr.io/praetorium-render/compositions",
  });
  Object.assign(value.buildWorker, {
    signingKeyId: "render-key",
    compositionRepository: "ghcr.io/praetorium-render/compositions",
    buildctlPath: "/run/current-system/sw/bin/buildctl",
  });
  value.buildPolicy.targetPlatform = "linux/amd64";
  value.buildPolicy.cacheRetention = { maxBytes: 0, maxEntries: 1, minAgeMs: 0, maxEvictions: 1 };
  value.buildPolicy.builderKeys = [
    {
      keyId: "render-key",
      publicKeyBase64: Buffer.alloc(32, 1).toString("base64"),
      revoked: false,
      validFrom: null,
      validUntil: null,
    },
  ];
  for (const key of Object.keys(value.images))
    value.images[key] = `ghcr.io/praetorium-render/${key.toLowerCase()}@sha256:${"a".repeat(64)}`;
  return value;
}

test("render refuses an incomplete inventory before contacting any cluster", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/deploy-infrastructure.mjs", "render", "--inventory", sourceInventory],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /inventory is not ready/);
  assert.equal(result.stdout, "");
});

test(
  "actual shared render/apply assembly includes every admission binding, RBAC and expanded network rule",
  {
    skip:
      kustomize.status === 0
        ? false
        : "standalone Kustomize is required for the local render proof",
  },
  () => {
    const inventory = renderInventory();
    assert.deepEqual(validateInventory(inventory), { errors: [], blockers: [] });
    const temporary = mkdtempSync(path.join(os.tmpdir(), "praetorium-static-render-"));
    try {
      const input = path.join(temporary, "render-only-inventory.json");
      writeFileSync(input, JSON.stringify(inventory), { mode: 0o600 });
      const result = spawnSync(
        process.execPath,
        ["scripts/deploy-infrastructure.mjs", "render", "--inventory", input],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, KUBECONFIG: path.join(temporary, "does-not-exist") },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /@@[A-Z0-9_]+@@/);
      assert.match(
        result.stdout,
        /PRAETORIUM_BUILD_COMPOSITION_REPOSITORY: ["']?praetorium-render\/compositions["']?\s*$/m,
      );
      assert.equal((result.stdout.match(/^kind: ValidatingAdmissionPolicy$/gm) ?? []).length, 7);
      assert.equal(
        (result.stdout.match(/^kind: ValidatingAdmissionPolicyBinding$/gm) ?? []).length,
        7,
      );
      assert.equal((result.stdout.match(/^kind: ClusterRole$/gm) ?? []).length, 2);
      assert.equal((result.stdout.match(/^kind: ClusterRoleBinding$/gm) ?? []).length, 1);
      for (const cidr of ["10.96.0.1/32", "10.0.1.2/32", "10.0.1.3/32", "10.0.1.4/32"])
        assert.ok(result.stdout.includes(cidr), cidr);
      for (const port of [6443, 8443, 8080])
        assert.match(result.stdout, new RegExp(`port: ${port}\\b`));
      assert.match(result.stdout, /name: praetorium-provisioner-bootstrap/);
      assert.match(result.stdout, /name: praetorium-provisioner-tenant-runtime/);
      assert.doesNotMatch(result.stdout, /^\s*(?:name|namespace):\s*["']?praetorium-instances-/m);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
