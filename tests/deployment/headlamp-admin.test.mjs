import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const addon = "infrastructure/kubernetes/addons/headlamp";
const read = (p) => readFileSync(path.join(root, p), "utf8");
const manifest = (name) => read(`${addon}/${name}`);

test("Headlamp is an explicit optional addon, never part of normal Praetorium deployment", () => {
  const kustomization = manifest("kustomization.yaml");
  const entries = [...kustomization.matchAll(/^  - ([-a-z]+\.yaml)$/gmu)].map((match) => match[1]);
  assert.deepEqual(entries, [
    "namespace.yaml",
    "helm-source.yaml",
    "helm-release.yaml",
    "network-policy.yaml",
  ]);
  for (const target of [
    "infrastructure/kubernetes/base/kustomization.yaml",
    "infrastructure/kubernetes/controllers/kustomization.yaml",
    "infrastructure/kubernetes/overlays/deployment/kustomization.yaml",
    "infrastructure/kubernetes/overlays/disposable/kustomization.yaml",
  ]) {
    assert.doesNotMatch(read(target), /addons\/headlamp|praetorium-headlamp/u);
  }
});

test("Headlamp is pinned to the official Helm chart and restricted to a separate namespace", () => {
  const ns = manifest("namespace.yaml");
  const source = manifest("helm-source.yaml");
  const release = manifest("helm-release.yaml");
  assert.match(ns, /name: praetorium-admin/u);
  for (const mode of ["enforce", "audit", "warn"])
    assert.match(ns, new RegExp(`pod-security\\.kubernetes\\.io/${mode}: restricted`, "u"));
  assert.match(source, /apiVersion: source\.toolkit\.fluxcd\.io\/v1/u);
  assert.match(source, /url: https:\/\/kubernetes-sigs\.github\.io\/headlamp\//u);
  assert.match(release, /apiVersion: helm\.toolkit\.fluxcd\.io\/v2/u);
  assert.match(release, /name: praetorium-headlamp/u);
  assert.match(release, /namespace: flux-system/u);
  assert.match(release, /targetNamespace: praetorium-admin/u);
  assert.match(release, /chart: headlamp/u);
  assert.match(release, /version: "0\.45\.0"/u);
});

test("Headlamp grants no cluster-admin privilege and opens no external entry point", () => {
  const release = manifest("helm-release.yaml");
  const policy = manifest("network-policy.yaml");
  assert.match(release, /clusterRoleBinding:\n      create: false/u);
  assert.match(release, /unsafeUseServiceAccountToken: false/u);
  assert.match(release, /enableHelm: false/u);
  assert.match(release, /pluginsManager:\n      enabled: false/u);
  assert.match(release, /clusterInventory:\n        enabled: false/u);
  assert.match(release, /service:\n      type: ClusterIP/u);
  assert.match(release, /ingress:\n      enabled: false/u);
  assert.match(release, /httpRoute:\n      enabled: false/u);
  assert.doesNotMatch(release, /type: NodePort|type: LoadBalancer|unsafeUseServiceAccountToken: true|clusterRoleName: cluster-admin/u);
  assert.match(policy, /kind: NetworkPolicy/u);
  assert.match(policy, /namespace: praetorium-admin/u);
  assert.match(policy, /podSelector: \{\}\n  policyTypes:\n    - Ingress/u);
  assert.doesNotMatch(policy, /ingress:\s*-/u);
});

test("Headlamp workload respects restricted pod security and bounded resources", () => {
  const release = manifest("helm-release.yaml");
  assert.match(release, /readOnlyRootFilesystem: true/u);
  assert.match(release, /runAsNonRoot: true/u);
  assert.match(release, /allowPrivilegeEscalation: false/u);
  assert.match(release, /seccompProfile:\n        type: RuntimeDefault/u);
  assert.match(release, /capabilities:\n        drop:\n          - ALL/u);
  assert.match(release, /requests:\n        cpu: 50m\n        memory: 128Mi/u);
  assert.match(release, /limits:\n        cpu: 500m\n        memory: 512Mi/u);
  assert.match(release, /persistentVolumeClaim:\n      enabled: false/u);
});
