import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeWorkerDeploymentSecrets } from "../../scripts/worker-deployment-secrets.mjs";
import { platformDeploymentSteps } from "../../scripts/deployment-plan.mjs";

test("platform preflight checks immutable K3s inputs and D1 readiness without changing resources", () => {
  assert.deepEqual(platformDeploymentSteps("--check", false), [
    { script: "deploy-k3s.mjs", mode: "--check", stage: "K3s resource/image preflight" },
    {
      script: "deploy-cloudflare.mjs",
      mode: "--preflight",
      stage: "Cloudflare resource/secret preflight",
    },
    { script: "deploy-cloudflare.mjs", mode: "--check", stage: "remote D1 migration readback" },
  ]);
});

test("platform apply migrates and reads back D1 before Build Worker images and Workers", () => {
  const steps = platformDeploymentSteps("--apply", true);
  const scriptAndMode = steps.map(({ script, mode }) => [script, mode]);
  assert.deepEqual(scriptAndMode, [
    ["deploy-k3s.mjs", "--check"],
    ["deploy-cloudflare.mjs", "--preflight"],
    ["service-image-publication.mjs", null],
    ["deploy-cloudflare.mjs", "--migrate"],
    ["coordination", "--apply"],
    ["deploy-k3s.mjs", "--apply"],
    ["verify-work-notifications.mjs", null],
    ["deploy-cloudflare.mjs", "--workers"],
  ]);
  const migration = steps.findIndex((step) => step.mode === "--migrate");
  const publication = steps.findIndex((step) => step.script === "service-image-publication.mjs");
  const k3sApply = steps.findIndex(
    (step) => step.script === "deploy-k3s.mjs" && step.mode === "--apply",
  );
  const workerDeploy = steps.findIndex((step) => step.mode === "--workers");
  assert.ok(
    publication > 1 && publication < migration && migration < k3sApply && k3sApply < workerDeploy,
  );
});

test("notification-disabled deployments skip only the notification readiness gate", () => {
  const steps = platformDeploymentSteps("--apply", false);
  assert.ok(!steps.some((step) => step.script === "verify-work-notifications.mjs"));
  assert.ok(steps.some((step) => step.mode === "--migrate"));
  assert.ok(steps.some((step) => step.mode === "--workers"));
  assert.throws(() => platformDeploymentSteps("--publish", false), /must be --check or --apply/u);
});

test("Worker deployment secret files retain Wrangler text normalization and each Worker credential scope", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "praetorium-worker-secrets-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const privateBytes = (role) => Buffer.from(`fixture:${role}\n`);
  const files = writeWorkerDeploymentSecrets({
    directory,
    privateBytes,
    notificationsEnabled: true,
    hasReleaseOperatorToken: true,
  });
  assert.deepEqual(JSON.parse(readFileSync(files.gateway)), {
    INSTANCE_ACCESS_SERVICE_AUTH_TOKEN: "fixture:instanceAccessServiceAuth",
  });
  assert.deepEqual(JSON.parse(readFileSync(files.control)), {
    PROVISIONER_AUTH_TOKEN: "fixture:controlPlaneCredential",
    BUILD_WORKER_AUTH_TOKEN: "fixture:buildWorkerControlPlaneAuth",
    REGISTRY_PULL_CREDENTIAL: "fixture:buildWorkerRegistryPull",
    PROVISIONER_WORK_NOTIFICATION_TOKEN: "fixture:provisionerWorkNotificationToken",
    BUILD_WORK_NOTIFICATION_TOKEN: "fixture:buildWorkerWorkNotificationToken",
    RELEASE_OPERATOR_TOKEN: "fixture:releaseOperatorToken",
  });
  for (const filename of Object.values(files)) assert.equal(statSync(filename).mode & 0o777, 0o600);
  assert.throws(
    () =>
      writeWorkerDeploymentSecrets({
        directory,
        privateBytes,
        notificationsEnabled: true,
        hasReleaseOperatorToken: true,
      }),
    /EEXIST/,
  );
});

test("Worker deployment does not read disabled optional credentials", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "praetorium-worker-secrets-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const roles = [];
  const files = writeWorkerDeploymentSecrets({
    directory,
    privateBytes: (role) => {
      roles.push(role);
      return Buffer.from("fixture");
    },
    notificationsEnabled: false,
    hasReleaseOperatorToken: false,
  });
  assert.deepEqual(roles, [
    "instanceAccessServiceAuth",
    "controlPlaneCredential",
    "buildWorkerControlPlaneAuth",
    "buildWorkerRegistryPull",
  ]);
  assert.equal(Object.keys(JSON.parse(readFileSync(files.control))).length, 3);
});

test("Worker deployment reads all approved credentials before writing secret files", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "praetorium-worker-secrets-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(
    () =>
      writeWorkerDeploymentSecrets({
        directory,
        privateBytes: (role) => {
          if (role === "buildWorkerRegistryPull") throw new Error("missing fixture credential");
          return Buffer.from("fixture");
        },
        notificationsEnabled: false,
        hasReleaseOperatorToken: false,
      }),
    /missing fixture credential/,
  );
  assert.deepEqual(readdirSync(directory), []);
});
