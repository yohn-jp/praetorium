import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("tenant Pod policy matches the labels and security properties the runtime emits", async () => {
  const [policy, labels, provider, renderer] = await Promise.all([
    read("infrastructure/kubernetes/policies/tenant-pod-policy.yaml"),
    read("plugins/kubernetes/src/labels.ts"),
    read("plugins/kubernetes/src/kubernetes/provider.ts"),
    read("plugins/kubernetes/src/kubernetes/renderer.ts"),
  ]);

  assert.match(policy, /failurePolicy:\s*Fail/);
  assert.match(policy, /arcadia\.io\/platform:\s*arcadia-platform/);
  assert.match(policy, /app\.kubernetes\.io\/managed-by:\s*arcadia-provisioner/);
  assert.match(labels, /PLATFORM_LABEL_VALUE\s*=\s*"arcadia-platform"/);
  assert.match(labels, /MANAGED_BY_LABEL_VALUE\s*=\s*"arcadia-provisioner"/);
  assert.match(provider, /function namespaceLabels\(identity: InstanceIdentity\)/);
  assert.match(provider, /\[PLATFORM_LABEL_KEY\]: PLATFORM_LABEL_VALUE/);
  assert.match(provider, /\[MANAGED_BY_LABEL_KEY\]: MANAGED_BY_LABEL_VALUE/);
  assert.match(policy, /operations:\s*\["CREATE",\s*"UPDATE"\]/);
  assert.match(policy, /resources:\s*\["pods"\]/);
  assert.match(policy, /validationActions:\s*\[Deny\]/);

  assert.match(renderer, /automountServiceAccountToken:\s*false/);
  assert.match(renderer, /runAsNonRoot:\s*true/);
  assert.match(renderer, /seccompProfile:\s*\{\s*type:\s*"RuntimeDefault"/);
  assert.match(renderer, /allowPrivilegeEscalation:\s*false/);
  assert.match(renderer, /readOnlyRootFilesystem:\s*true/);
  assert.match(renderer, /capabilities:\s*\{\s*drop:\s*\["ALL"\]\s*\}/);
  assert.match(renderer, /image:\s*spec\.release\?\.artifactRef/);
  assert.match(renderer, /requests:\s*\{[\s\S]*?"ephemeral-storage":/);
  assert.match(renderer, /limits:\s*\{[\s\S]*?"ephemeral-storage":/);
  assert.match(renderer, /emptyDir:\s*\{\s*sizeLimit:/);
  assert.doesNotMatch(renderer, /hostPath\s*:|hostPort\s*:/);

  for (const expression of [
    "automountServiceAccountToken == false",
    "hostNetwork",
    "hostPID",
    "hostIPC",
    "shareProcessNamespace",
    "volume.hostPath",
    "allowPrivilegeEscalation == false",
    "readOnlyRootFilesystem == true",
    "capability == \"ALL\"",
    "container.image.matches(\"^.+@sha256:[a-f0-9]{64}$\")",
    '"ephemeral-storage" in container.resources.requests',
    '"ephemeral-storage" in container.resources.limits',
    "port.hostPort",
  ]) {
    assert.ok(policy.includes(expression), `policy is missing ${expression}`);
  }

  assert.doesNotMatch(policy, /pod-security\.kubernetes\.io/);
  assert.doesNotMatch(policy, /PersistentVolumeClaim|Restic/i);
});
