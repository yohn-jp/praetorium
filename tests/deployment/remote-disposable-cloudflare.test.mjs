import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertRemoteDisposableSecretMaterials,
  remoteDisposableSecretRoles,
  writeRemoteDisposableWorkerDeploymentSecrets,
} from "../../scripts/worker-deployment-secrets.mjs";

test("remote-disposable Worker secrets are projected only to the test Control Plane and Gateway", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "praetorium-t14-worker-secrets-"));
  const directory = path.join(root, "praetorium-t14-canary");
  mkdirSync(directory, { mode: 0o700 });
  try {
    const supplied = new Map(
      remoteDisposableSecretRoles.map((role) => [role, Buffer.from(`fixture-secret-value:${role}`)]),
    );
    assertRemoteDisposableSecretMaterials((role) => supplied.get(role));
    const files = writeRemoteDisposableWorkerDeploymentSecrets({
      directory,
      privateBytes: (role) => {
        assert.ok(supplied.has(role), `unexpected secret role ${role}`);
        return supplied.get(role);
      },
    });
    assert.deepEqual(Object.keys(files).sort(), ["control", "gateway"]);
    const control = JSON.parse(readFileSync(files.control, "utf8"));
    const gateway = JSON.parse(readFileSync(files.gateway, "utf8"));
    assert.deepEqual(Object.keys(control).sort(), [
      "BUILD_WORKER_AUTH_TOKEN",
      "CONTROL_PLANE_GATEWAY_AUTH",
      "PROVISIONER_AUTH_TOKEN",
      "REGISTRY_PULL_CREDENTIAL",
      "RELEASE_OPERATOR_TOKEN",
      "RUNTIME_CONTROL_SIGNING_KEY",
      "RUNTIME_CREDENTIAL_RETIREMENT_AUTH",
      "RUNTIME_IDENTITY_SIGNING_KEY",
    ].sort());
    assert.deepEqual(Object.keys(gateway).sort(), [
      "CONTROL_PLANE_GATEWAY_AUTH",
      "GATEWAY_CREDENTIAL_DIGEST_PEPPER",
      "GATEWAY_GITHUB_WEBHOOK_SECRET",
      "GATEWAY_HANDOFF_DIGEST_PEPPER",
      "GATEWAY_SESSION_DIGEST_PEPPER",
      "GATEWAY_SIGNING_KEY",
      "GATEWAY_TOKEN_ENCRYPTION_KEY",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "INSTANCE_ACCESS_SERVICE_AUTH_TOKEN",
      "RUNTIME_CREDENTIAL_RETIREMENT_AUTH",
    ].sort());
    assert.equal(control.CONTROL_PLANE_GATEWAY_AUTH, gateway.CONTROL_PLANE_GATEWAY_AUTH);
    assert.equal(
      control.RUNTIME_CREDENTIAL_RETIREMENT_AUTH,
      gateway.RUNTIME_CREDENTIAL_RETIREMENT_AUTH,
    );
    assert.equal(Object.hasOwn(control, "ADMIN_CONTROL_PLANE_AUTH"), false);
    for (const file of Object.values(files)) assert.equal(statSync(file).mode & 0o777, 0o600);

    const duplicated = new Map(supplied);
    duplicated.set("t14ReleaseOperatorToken", duplicated.get("t14BuildWorkerAuthToken"));
    assert.throws(
      () => assertRemoteDisposableSecretMaterials((role) => duplicated.get(role)),
      /distinct test values/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
