import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateInventory } from "../../infrastructure/scripts/inventory.mjs";
import { renderWorkerTemplate } from "../../infrastructure/scripts/worker-config.mjs";
import { renderPlatformBundle } from "../../infrastructure/scripts/render-platform.mjs";
import {
  validateWorkNotificationTokens,
  verifyWorkNotificationEndpoints,
  workNotificationEndpoints,
} from "../../infrastructure/scripts/work-notifications.mjs";

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
  inventory.domains.gatewayOrigin = "https://gateway.praetorium.example.net";
  const template = readFileSync(path.join(root, "infrastructure/workers/control-plane.template.json"), "utf8");
  const projected = JSON.parse(renderWorkerTemplate(template, inventory, "control-plane"));
  assert.equal(projected.vars.PROVISIONER_CLUSTER_ID, inventory.clusterId);
  assert.equal(projected.vars.RUNTIME_REGISTRY_HOST, new URL(inventory.buildPolicy.registryUrl).host);
  assert.equal(projected.vars.GIT_CREDENTIAL_BROKER_LOCATOR,
    new URL("/internal/github/credential", inventory.domains.gatewayOrigin).href);
  assert.equal(projected.vars.PROVISIONER_WORKER_ID, inventory.clusterId + "-provisioner");
  assert.equal(projected.d1_databases[0].binding, "CONTROL_PLANE_DB");
  assert.equal(projected.vars.PROVISIONER_WORK_NOTIFICATION_URL, undefined);
  assert.equal(projected.vars.BUILD_WORK_NOTIFICATION_URL, undefined);

  const enabled = structuredClone(inventory);
  enabled.workNotifications = { enabled: true };
  enabled.secretRefs.provisionerWorkNotificationToken = {
    name: "praetorium-provisioner-work-notification-token",
    key: "token",
  };
  enabled.secretRefs.buildWorkerWorkNotificationToken = {
    name: "praetorium-build-worker-work-notification-token",
    key: "token",
  };
  const enabledProjection = JSON.parse(renderWorkerTemplate(template, enabled, "control-plane"));
  assert.deepEqual(workNotificationEndpoints(enabled), {
    provisioner: "https://notify-provisioner.instances.praetorium.localhost/internal/work-available",
    build: "https://notify-build.instances.praetorium.localhost/internal/work-available",
  });
  assert.equal(
    enabledProjection.vars.PROVISIONER_WORK_NOTIFICATION_URL,
    workNotificationEndpoints(enabled).provisioner,
  );
  assert.equal(
    enabledProjection.vars.BUILD_WORK_NOTIFICATION_URL,
    workNotificationEndpoints(enabled).build,
  );
});

test("provisioned Coordination binding survives canonical Worker rendering and rejects invalid activation", () => {
  const inventory = json("infrastructure/test/disposable-inventory.json");
  const template = readFileSync(path.join(root, "infrastructure/workers/control-plane.template.json"), "utf8");
  assert.equal(JSON.parse(renderWorkerTemplate(template, inventory, "control-plane")).vpc_services, undefined);
  inventory.workNotifications = { enabled: true, coordinationVpcServiceId: "01a158fc-ef0d-7d11-8976-af6247908574" };
  inventory.secretRefs.provisionerWorkNotificationToken = { name: "provisioner-hint", key: "token" };
  inventory.secretRefs.buildWorkerWorkNotificationToken = { name: "build-hint", key: "token" };
  assert.deepEqual(validateInventory(inventory).errors, []);
  const rendered = JSON.parse(renderWorkerTemplate(template, inventory, "control-plane"));
  assert.deepEqual(rendered.vpc_services, [{ binding: "COORDINATION_SERVICE", service_id: inventory.workNotifications.coordinationVpcServiceId }]);
  const gateway = readFileSync(path.join(root, "infrastructure/workers/gateway.template.json"), "utf8");
  assert.equal(JSON.parse(renderWorkerTemplate(gateway, inventory, "gateway")).vpc_services, undefined);
  inventory.workNotifications.enabled = false;
  assert.ok(validateInventory(inventory).errors.some((e) => e.includes("coordinationVpcServiceId")));
  inventory.workNotifications.enabled = true;
  inventory.workNotifications.coordinationVpcServiceId = "unprovisioned";
  assert.ok(validateInventory(inventory).errors.some((e) => e.includes("coordinationVpcServiceId")));
});

test("work notification inventory requires dedicated secret refs and deployment render selects the gated overlay", () => {
  const baseline = json("infrastructure/test/disposable-inventory.json");
  baseline.network.kubernetesApiEndpoints = [{ address: "10.96.0.1", port: 6443 }];
  baseline.domains.gatewayOrigin = "https://gateway.praetorium.example.net";
  baseline.domains.gatewayServiceUrl = "https://gateway.praetorium.example.net";
  baseline.domains.controlPlaneUrl = "https://control.praetorium.example.net";
  baseline.domains.tlsSecretName = "custom-instance-tls";
  baseline.buildkit.endpoint = "tcp://10.20.30.40:1234";
  baseline.buildkit.frontendRepository = "ghcr.io/praetorium/frontend";
  baseline.buildkit.outputRepository = "ghcr.io/praetorium/output";
  baseline.buildWorker.signingKeyId = "worker-signing-v1";
  baseline.buildWorker.compositionRepository = "praetorium/platform";
  baseline.buildWorker.buildctlPath = "/usr/local/bin/buildctl";
  for (const image of Object.keys(baseline.images)) {
    const repository = image.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
    baseline.images[image] = `ghcr.io/praetorium/${repository}@sha256:${"a".repeat(64)}`;
  }
  const enabled = structuredClone(baseline);
  enabled.workNotifications = { enabled: true };
  const missing = validateInventory(enabled);
  assert.match(missing.errors.join("\n"), /secretRefs must contain exactly: .*buildWorkerWorkNotificationToken.*provisionerWorkNotificationToken/u);
  assert.ok(missing.blockers.includes(
    "secretRefs.provisionerWorkNotificationToken is required when workNotifications.enabled is true",
  ));
  assert.ok(missing.blockers.includes(
    "secretRefs.buildWorkerWorkNotificationToken is required when workNotifications.enabled is true",
  ));
  enabled.secretRefs.provisionerWorkNotificationToken = {
    name: "praetorium-provisioner-work-notification-token",
    key: "token",
  };
  enabled.secretRefs.buildWorkerWorkNotificationToken = {
    name: "praetorium-build-worker-work-notification-token",
    key: "token",
  };
  assert.deepEqual(validateInventory(enabled).errors, []);

  const renderedKustomization = renderPlatformBundle(baseline, {
    overlay: "disposable",
    buildKustomize: (directory) => readFileSync(
      path.resolve(directory, "../deployment/kustomization.yaml"),
      "utf8",
    ),
  });
  assert.doesNotMatch(renderedKustomization, /work-notifications/u);

  const renderedEnabledKustomization = renderPlatformBundle(enabled, {
    overlay: "disposable",
    buildKustomize: (directory) => {
      const deployment = path.resolve(directory, "../deployment");
      const kustomization = readFileSync(path.join(deployment, "kustomization.yaml"), "utf8");
      const buildIngress = readFileSync(
        path.join(deployment, "work-notifications/ingress-routes.yaml"),
        "utf8",
      );
      const buildPatch = readFileSync(
        path.join(deployment, "work-notifications/build-worker-deployment-patch.yaml"),
        "utf8",
      );
      const certificate = readFileSync(
        path.join(deployment, "work-notifications/build-worker-certificate.yaml"),
        "utf8",
      );
      return [kustomization, buildIngress, buildPatch, certificate].join("\n");
    },
  });
  assert.match(renderedEnabledKustomization, /- work-notifications/u);
  assert.match(renderedEnabledKustomization, /notify-provisioner\.instances\.praetorium\.localhost/u);
  assert.match(renderedEnabledKustomization, /notify-build\.instances\.praetorium\.localhost/u);
  assert.match(renderedEnabledKustomization, /secretName: "custom-instance-tls"/u);
  assert.match(renderedEnabledKustomization, /PRAETORIUM_BUILD_WORK_NOTIFICATION_TOKEN/u);
  assert.match(renderedEnabledKustomization, /praetorium-build-worker-notification-tls/u);
  assert.doesNotMatch(renderedEnabledKustomization, /@@[A-Z0-9_]+@@/u);
});

test("work notification tokens are printable and distinct from claim and registry credentials", () => {
  const bytes = (value) => Buffer.from(value, "ascii");
  const pullUsername = "pull-user-".repeat(4);
  const pullPassword = "pull-password-".repeat(4);
  const pushUsername = "push-user-".repeat(4);
  const pushPassword = "push-password-".repeat(4);
  const pullBytes = Buffer.from(JSON.stringify({ username: pullUsername, password: pullPassword }));
  const pushAuth = Buffer.from(`${pushUsername}:${pushPassword}`).toString("base64");
  const pushBytes = Buffer.from(JSON.stringify({
    auths: {
      "https://ghcr.io": {
        username: pushUsername,
        password: pushPassword,
        auth: pushAuth,
      },
    },
  }));
  const registry = { registryPull: pullBytes, registryPush: pushBytes, registryHost: "ghcr.io" };
  const base = {
    provisioner: bytes("p".repeat(48)),
    build: bytes("b".repeat(48)),
    provisionerClaim: bytes("c".repeat(48)),
    buildClaim: bytes("d".repeat(48)),
    ...registry,
  };
  assert.doesNotThrow(() => validateWorkNotificationTokens({
    ...base,
  }));
  const assertRegistryConflict = (token, role = "provisioner", registryOverride = {}) => assert.throws(
    () => validateWorkNotificationTokens({
      ...base,
      ...registryOverride,
      [role]: Buffer.from(token),
    }),
    /distinct from registry credentials/u,
  );
  const registryTokens = [
    pullUsername,
    pullPassword,
    `${pullUsername}:${pullPassword}`,
    Buffer.from(`${pullUsername}:${pullPassword}`).toString("base64"),
    pushUsername,
    pushPassword,
    `${pushUsername}:${pushPassword}`,
    pushAuth,
  ];
  for (const role of ["provisioner", "build"]) {
    for (const candidate of registryTokens) assertRegistryConflict(candidate, role);
  }
  assertRegistryConflict(pullBytes, "provisioner");
  assertRegistryConflict(pushBytes, "build");
  const authOnlyPush = Buffer.from(JSON.stringify({
    auths: { "ghcr.io": { auth: pushAuth } },
  }));
  assertRegistryConflict(pushUsername, "build", { registryPush: authOnlyPush });
  const duplicateCanonicalHost = Buffer.from(JSON.stringify({
    auths: {
      "ghcr.io": { auth: pushAuth },
      "https://ghcr.io": {
        auth: Buffer.from(`duplicate-user:${"duplicate-entry-password-".repeat(2)}`).toString("base64"),
      },
    },
  }));
  assertRegistryConflict("duplicate-entry-password-".repeat(2), "provisioner", {
    registryPush: duplicateCanonicalHost,
  });
  assert.throws(() => validateWorkNotificationTokens({
    ...base,
    provisioner: bytes("c".repeat(48)),
  }), /distinct from claim credentials/u);
  assert.throws(() => validateWorkNotificationTokens({
    ...base,
    provisioner: bytes("x".repeat(31)),
  }), /32-512 printable ASCII/u);
  assert.throws(() => validateWorkNotificationTokens({
    ...base,
    provisioner: Buffer.concat([bytes("x".repeat(31)), Buffer.from([0xe1])]),
  }), /32-512 printable ASCII/u);
});

test("notification readiness probe uses the two dedicated tokens and requires HTTP 202", async () => {
  const calls = [];
  await verifyWorkNotificationEndpoints(
    {
      provisioner: "https://notify-provisioner.instances.example.net/internal/work-available",
      build: "https://notify-build.instances.example.net/internal/work-available",
    },
    { provisioner: "p".repeat(40), build: "b".repeat(40) },
    async (url, options) => {
      calls.push({ url: String(url), options });
      return { status: 202, body: { cancel: async () => undefined } };
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${"p".repeat(40)}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { version: 1, kind: "operation" });
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${"b".repeat(40)}`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { version: 1, kind: "build" });
  await assert.rejects(
    verifyWorkNotificationEndpoints(
      {
        provisioner: "https://notify-provisioner.instances.example.net/internal/work-available",
        build: "https://notify-build.instances.example.net/internal/work-available",
      },
      { provisioner: "p".repeat(40), build: "b".repeat(40) },
      async () => ({ status: 401, body: { cancel: async () => undefined } }),
    ),
    /returned HTTP 401, expected 202/u,
  );
});

test("new commands have valid Node or Bash syntax without remote effects", () => {
  const scripts = [
    "scripts/deploy-k3s.mjs", "scripts/deploy-cloudflare.mjs",
    "scripts/deploy-platform.mjs", "scripts/deploy-workers.mjs", "scripts/verify-work-notifications.mjs",
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
