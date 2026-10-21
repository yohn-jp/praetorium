import assert from "node:assert/strict";
import test from "node:test";
import { platformDeploymentSteps } from "../../scripts/deployment-plan.mjs";

test("platform preflight checks immutable K3s inputs and D1 readiness without changing resources", () => {
  assert.deepEqual(platformDeploymentSteps("--check", false), [
    { script: "deploy-k3s.mjs", mode: "--check", stage: "K3s resource/image preflight" },
    { script: "deploy-cloudflare.mjs", mode: "--preflight", stage: "Cloudflare resource/secret preflight" },
    { script: "deploy-cloudflare.mjs", mode: "--check", stage: "remote D1 migration readback" },
  ]);
});

test("platform apply migrates and reads back D1 before Build Worker images and Workers", () => {
  const steps = platformDeploymentSteps("--apply", true);
  const scriptAndMode = steps.map(({ script, mode }) => [script, mode]);
  assert.deepEqual(scriptAndMode, [
    ["deploy-k3s.mjs", "--check"],
    ["deploy-cloudflare.mjs", "--preflight"],
    ["deploy-cloudflare.mjs", "--migrate"],
    ["deploy-k3s.mjs", "--apply"],
    ["verify-work-notifications.mjs", null],
    ["deploy-cloudflare.mjs", "--workers"],
  ]);
  const migration = steps.findIndex((step) => step.mode === "--migrate");
  const k3sApply = steps.findIndex((step) => step.script === "deploy-k3s.mjs" && step.mode === "--apply");
  const workerDeploy = steps.findIndex((step) => step.mode === "--workers");
  assert.ok(migration < k3sApply && k3sApply < workerDeploy);
});

test("notification-disabled deployments skip only the notification readiness gate", () => {
  const steps = platformDeploymentSteps("--apply", false);
  assert.ok(!steps.some((step) => step.script === "verify-work-notifications.mjs"));
  assert.ok(steps.some((step) => step.mode === "--migrate"));
  assert.ok(steps.some((step) => step.mode === "--workers"));
  assert.throws(() => platformDeploymentSteps("--publish", false), /must be --check or --apply/u);
});
