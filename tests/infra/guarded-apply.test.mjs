import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { applyGuardedBundle } from "../../infrastructure/scripts/guarded-apply.mjs";

const require = createRequire(import.meta.url);
const yaml = require("../../node_modules/.pnpm/node_modules/js-yaml");
const documents = [
  "provisioner-boundary.yaml",
  "provisioner-history-pvc.yaml",
  "provisioner-rolebinding.yaml",
  "provisioner-ingressroute.yaml",
  "provisioner-networkpolicy.yaml",
  "tenant-pod-policy.yaml",
].flatMap((file) =>
  yaml.loadAll(
    readFileSync(
      new URL(`../../infrastructure/kubernetes/policies/${file}`, import.meta.url),
      "utf8",
    ),
  ),
);
const bundle = [
  ...documents,
  {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRoleBinding",
    metadata: { name: "praetorium-provisioner-bootstrap" },
  },
]
  .map((doc) => yaml.dump(doc))
  .join("---\n");

function clients(failure) {
  const calls = [];
  const check = (phase) => {
    calls.push(phase);
    if (failure === phase) throw new Error(`injected ${phase} failure`);
  };
  return {
    calls,
    bundle,
    discover() {
      check("discovery");
      return {
        apiVersion: "v1",
        kind: "APIResourceList",
        groupVersion: "admissionregistration.k8s.io/v1",
        resources: ["validatingadmissionpolicies", "validatingadmissionpolicybindings"].map(
          (name) => ({ name }),
        ),
      };
    },
    serverDryRun(input) {
      assert.equal(input, bundle);
      check("dry-run");
    },
    apply(input) {
      if (input === bundle) check("full-apply");
      else {
        assert.doesNotMatch(input, /kind: ClusterRoleBinding/);
        assert.equal(yaml.loadAll(input).length, 16);
        check("guard-apply");
      }
    },
    readPolicy(name) {
      check("read-policy");
      const source = documents.find(
        (doc) => doc.kind === "ValidatingAdmissionPolicy" && doc.metadata.name === name,
      );
      return {
        ...source,
        metadata: { ...source.metadata, generation: 1 },
        status: { observedGeneration: 1, typeChecking: {} },
      };
    },
    readBinding(name) {
      check("read-binding");
      return documents.find(
        (doc) => doc.kind === "ValidatingAdmissionPolicyBinding" && doc.metadata.name === name,
      );
    },
  };
}

test("bootstrap bundle is applied only after discovery, full server dry-run, guard apply and live readiness", async () => {
  const client = clients();
  await applyGuardedBundle(client);
  assert.deepEqual(client.calls.slice(0, 3), ["discovery", "dry-run", "guard-apply"]);
  assert.equal(client.calls.filter((call) => call === "read-policy").length, 8);
  assert.equal(client.calls.filter((call) => call === "read-binding").length, 8);
  assert.equal(client.calls.at(-1), "full-apply");
});

for (const phase of ["discovery", "dry-run", "guard-apply", "read-policy", "read-binding"]) {
  test(`${phase} failure prevents bootstrap RBAC application`, async () => {
    const client = clients(phase);
    await assert.rejects(applyGuardedBundle(client), /injected .* failure/);
    assert.ok(!client.calls.includes("full-apply"));
    if (["discovery", "dry-run"].includes(phase)) assert.ok(!client.calls.includes("guard-apply"));
  });
}
