import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertAdmissionApi,
  selectAdmissionGuards,
  waitForAdmissionGuards,
} from "../../infrastructure/scripts/admission-readiness.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(repositoryRoot, "package.json"));
const yaml = require(resolve(repositoryRoot, "node_modules/.pnpm/node_modules/js-yaml"));
const policyFiles = [
  "provisioner-boundary.yaml",
  "provisioner-rolebinding.yaml",
  "provisioner-ingressroute.yaml",
  "provisioner-networkpolicy.yaml",
  "tenant-pod-policy.yaml",
];

function sourceDocuments() {
  return policyFiles.flatMap((file) =>
    yaml.loadAll(
      readFileSync(resolve(repositoryRoot, `infrastructure/kubernetes/policies/${file}`), "utf8"),
    ),
  );
}

const documents = sourceDocuments();
const sourcePolicies = documents.filter(
  (document) => document?.kind === "ValidatingAdmissionPolicy",
);
const sourceBindings = documents.filter(
  (document) => document?.kind === "ValidatingAdmissionPolicyBinding",
);

function apiDiscovery(
  resources = ["validatingadmissionpolicies", "validatingadmissionpolicybindings"],
) {
  return {
    apiVersion: "v1",
    kind: "APIResourceList",
    groupVersion: "admissionregistration.k8s.io/v1",
    resources: resources.map((name) => ({ name })),
  };
}

function readyPolicy(policy, index = 0) {
  const copy = structuredClone(policy);
  const generation = 2 + index;
  return {
    ...copy,
    metadata: { ...copy.metadata, generation },
    status: {
      observedGeneration: generation,
      typeChecking: index % 2 === 0 ? {} : { expressionWarnings: [] },
    },
  };
}

function apiDefaultedPolicy(policy, index = 0) {
  const copy = readyPolicy(policy, index);
  const matchConstraints = copy.spec.matchConstraints;
  matchConstraints.namespaceSelector ??= {};
  if (matchConstraints.namespaceSelector.matchLabels) {
    matchConstraints.namespaceSelector.matchLabels = Object.fromEntries(
      Object.entries(matchConstraints.namespaceSelector.matchLabels).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  }
  matchConstraints.objectSelector = {};
  for (const resourceRule of matchConstraints.resourceRules) resourceRule.scope = "*";
  return copy;
}

function readerMaps({
  policyOverrides = new Map(),
  bindingOverrides = new Map(),
  apiDefaulted = false,
} = {}) {
  const policies = new Map(
    sourcePolicies.map((policy, index) => [
      policy.metadata.name,
      policyOverrides.has(policy.metadata.name)
        ? policyOverrides.get(policy.metadata.name)
        : apiDefaulted
          ? apiDefaultedPolicy(policy, index)
          : readyPolicy(policy, index),
    ]),
  );
  const bindings = new Map(
    sourceBindings.map((binding) => [
      binding.metadata.name,
      bindingOverrides.has(binding.metadata.name)
        ? bindingOverrides.get(binding.metadata.name)
        : binding,
    ]),
  );
  const calls = { policies: [], bindings: [] };
  return {
    calls,
    policies,
    bindings,
    readPolicy: async (name) => {
      calls.policies.push(name);
      return policies.get(name) ?? null;
    },
    readBinding: async (name) => {
      calls.bindings.push(name);
      return bindings.get(name) ?? null;
    },
  };
}

test("admission discovery requires both v1 policy resources", () => {
  assert.doesNotThrow(() => assertAdmissionApi(apiDiscovery()));
  assert.throws(
    () => assertAdmissionApi(apiDiscovery(["validatingadmissionpolicies"])),
    /missing validatingadmissionpolicybindings/u,
  );
  assert.throws(
    () =>
      assertAdmissionApi({
        ...apiDiscovery(),
        groupVersion: "admissionregistration.k8s.io/v1beta1",
      }),
    /does not serve admissionregistration\.k8s\.io\/v1/u,
  );
});

test("readiness waits for the seven source policies and same-name bindings", async () => {
  assert.equal(sourcePolicies.length, 7);
  assert.equal(sourceBindings.length, 7);
  const readers = readerMaps();
  await waitForAdmissionGuards(readers);
  assert.deepEqual(
    readers.calls.policies.sort(),
    sourcePolicies.map(({ metadata }) => metadata.name).sort(),
  );
  assert.deepEqual(
    readers.calls.bindings.sort(),
    sourceBindings.map(({ metadata }) => metadata.name).sort(),
  );
});

test("readiness accepts v1.35.5 defaulted scopes and empty selectors", async () => {
  const readers = readerMaps({ apiDefaulted: true });
  await waitForAdmissionGuards(readers);
  for (const policy of readers.policies.values()) {
    const matchConstraints = policy.spec.matchConstraints;
    assert.deepEqual(matchConstraints.objectSelector, {});
    assert.ok(Object.hasOwn(matchConstraints, "namespaceSelector"));
    assert.ok(matchConstraints.resourceRules.every((resourceRule) => resourceRule.scope === "*"));
  }
  const podPolicy = readers.policies.get("praetorium-tenant-pods-restricted");
  assert.deepEqual(podPolicy.spec.matchConstraints.namespaceSelector, {
    matchLabels: {
      "arcadia.io/platform": "arcadia-platform",
      "app.kubernetes.io/managed-by": "arcadia-provisioner",
    },
  });
});

test("stale generation and incomplete type checking poll only until the deadline", async () => {
  const first = sourcePolicies[0];
  const pending = readyPolicy(first);
  pending.status.observedGeneration = pending.metadata.generation - 1;
  pending.status.typeChecking = undefined;
  const readers = readerMaps({ policyOverrides: new Map([[first.metadata.name, pending]]) });
  let clock = 0;
  const sleeps = [];
  await assert.rejects(
    waitForAdmissionGuards({
      ...readers,
      timeoutMs: 500,
      intervalMs: 250,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    }),
    /timed out waiting for admission guards.*policy-status\/praetorium-provisioner-instance-namespaces/u,
  );
  assert.deepEqual(sleeps, [250, 250]);
});

test("type-checking warnings reject immediately without another poll", async () => {
  const first = sourcePolicies[0];
  const warned = readyPolicy(first);
  warned.status.typeChecking.expressionWarnings = [
    {
      fieldRef: "spec.validations[0].expression",
      warning: "unknown field",
    },
  ];
  const readers = readerMaps({ policyOverrides: new Map([[first.metadata.name, warned]]) });
  let sleeps = 0;
  await assert.rejects(
    waitForAdmissionGuards({
      ...readers,
      now: () => 0,
      sleep: async () => {
        sleeps += 1;
      },
    }),
    /type-checking expressionWarnings/u,
  );
  assert.equal(sleeps, 0);
});

test("wrong writer identity and changed resource scope fail before waiting", async () => {
  const first = sourcePolicies[0];
  const mismatched = readyPolicy(first);
  mismatched.spec.matchConditions[0].expression =
    'request.userInfo.username == "system:serviceaccount:default:other"';
  const readers = readerMaps({ policyOverrides: new Map([[first.metadata.name, mismatched]]) });
  let sleeps = 0;
  await assert.rejects(
    waitForAdmissionGuards({
      ...readers,
      now: () => 0,
      sleep: async () => {
        sleeps += 1;
      },
    }),
    /unexpected identity match condition/u,
  );
  assert.equal(sleeps, 0);

  const changedScope = readyPolicy(first);
  changedScope.spec.matchConstraints.resourceRules[0].resources = ["pods"];
  const scopeReaders = readerMaps({
    policyOverrides: new Map([[first.metadata.name, changedScope]]),
  });
  await assert.rejects(
    waitForAdmissionGuards({
      ...scopeReaders,
      now: () => 0,
      sleep: async () => assert.fail("must not sleep"),
    }),
    /unexpected resource rules/u,
  );

  const excludedScope = readyPolicy(first);
  excludedScope.spec.matchConstraints.excludeResourceRules = [
    { apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["namespaces"] },
  ];
  const excludedReaders = readerMaps({
    policyOverrides: new Map([[first.metadata.name, excludedScope]]),
  });
  await assert.rejects(
    waitForAdmissionGuards({
      ...excludedReaders,
      now: () => 0,
      sleep: async () => assert.fail("must not sleep"),
    }),
    /unexpected matchConstraints fields/u,
  );
});

test("restrictive scope and non-empty default selectors fail immediately", async () => {
  const first = sourcePolicies[0];
  const cases = [
    {
      mutate(policy) {
        policy.spec.matchConstraints.resourceRules[0].scope = "Namespaced";
      },
      expected: /unexpected resource rules/u,
    },
    {
      mutate(policy) {
        policy.spec.matchConstraints.resourceRules[0].scope = "Cluster";
      },
      expected: /unexpected resource rules/u,
    },
    {
      mutate(policy) {
        policy.spec.matchConstraints.namespaceSelector = { matchLabels: { environment: "prod" } };
      },
      expected: /unexpected namespaceSelector/u,
    },
    {
      mutate(policy) {
        policy.spec.matchConstraints.objectSelector = { matchLabels: { protected: "true" } };
      },
      expected: /unexpected objectSelector/u,
    },
  ];
  for (const { mutate, expected } of cases) {
    const restricted = readyPolicy(first);
    mutate(restricted);
    const readers = readerMaps({
      apiDefaulted: true,
      policyOverrides: new Map([[first.metadata.name, restricted]]),
    });
    await assert.rejects(
      waitForAdmissionGuards({
        ...readers,
        now: () => 0,
        sleep: async () => assert.fail("must not sleep"),
      }),
      expected,
    );
  }

  const pod = sourcePolicies.find(
    (policy) => policy.metadata.name === "praetorium-tenant-pods-restricted",
  );
  const restrictedPod = readyPolicy(pod);
  restrictedPod.spec.matchConstraints.namespaceSelector.matchLabels.environment = "prod";
  const podReaders = readerMaps({
    apiDefaulted: true,
    policyOverrides: new Map([[pod.metadata.name, restrictedPod]]),
  });
  await assert.rejects(
    waitForAdmissionGuards({
      ...podReaders,
      now: () => 0,
      sleep: async () => assert.fail("must not sleep"),
    }),
    /unexpected namespaceSelector/u,
  );
});

test("non-fail-closed and deleting policies or bindings fail immediately", async () => {
  const firstPolicy = sourcePolicies[0];
  const firstBinding = sourceBindings[0];
  const invalidPolicy = readyPolicy(firstPolicy);
  invalidPolicy.spec.failurePolicy = "Ignore";
  const policyReaders = readerMaps({
    policyOverrides: new Map([[firstPolicy.metadata.name, invalidPolicy]]),
  });
  await assert.rejects(
    waitForAdmissionGuards({
      ...policyReaders,
      now: () => 0,
      sleep: async () => assert.fail("must not sleep"),
    }),
    /failurePolicy=Fail/u,
  );

  const deletingBinding = {
    ...firstBinding,
    metadata: { ...firstBinding.metadata, deletionTimestamp: "2026-10-17T00:00:00Z" },
  };
  const bindingReaders = readerMaps({
    bindingOverrides: new Map([[firstBinding.metadata.name, deletingBinding]]),
  });
  await assert.rejects(
    waitForAdmissionGuards({
      ...bindingReaders,
      now: () => 0,
      sleep: async () => assert.fail("must not sleep"),
    }),
    /is being deleted/u,
  );
});

test("binding name, policy, denial action, and unrestricted match scope are checked", async () => {
  const first = sourceBindings[0];
  const variants = [
    {
      ...first,
      spec: { ...first.spec, policyName: "some-other-policy" },
    },
    {
      ...first,
      spec: { ...first.spec, validationActions: ["Warn"] },
    },
    {
      ...first,
      spec: { ...first.spec, paramRef: { name: "unexpected" } },
    },
    {
      ...first,
      spec: { ...first.spec, matchResources: { namespaceSelector: { matchLabels: {} } } },
    },
  ];
  const expected = [
    /points to the wrong policy/u,
    /only validationActions=\[Deny\]/u,
    /must not parameterize/u,
    /must not parameterize/u,
  ];
  for (const [index, variant] of variants.entries()) {
    const readers = readerMaps({ bindingOverrides: new Map([[first.metadata.name, variant]]) });
    let sleeps = 0;
    await assert.rejects(
      waitForAdmissionGuards({
        ...readers,
        now: () => 0,
        sleep: async () => {
          sleeps += 1;
        },
      }),
      expected[index],
    );
    assert.equal(sleeps, 0);
  }
});

test("guard extraction selects only the exact seven policy and binding documents", () => {
  const bundle = documents.map((document) => yaml.dump(document)).join("---\n");
  const selected = selectAdmissionGuards(bundle);
  const selectedDocuments = yaml.loadAll(selected);
  assert.equal(selectedDocuments.length, 14);
  assert.equal(
    selectedDocuments.filter((document) => document.kind === "ValidatingAdmissionPolicy").length,
    7,
  );
  assert.equal(
    selectedDocuments.filter((document) => document.kind === "ValidatingAdmissionPolicyBinding")
      .length,
    7,
  );
  assert.ok(
    selectedDocuments.every(
      (document) =>
        document.apiVersion === "admissionregistration.k8s.io/v1" &&
        !["ClusterRole", "ClusterRoleBinding", "Role", "RoleBinding"].includes(document.kind),
    ),
  );
});

test("guard extraction rejects missing, duplicate, unknown, and malformed admission documents", () => {
  const bundle = documents.map((document) => yaml.dump(document)).join("---\n");
  const selected = selectAdmissionGuards(bundle);
  const selectedDocuments = yaml.loadAll(selected);
  const missing = selectedDocuments
    .filter((document) => document.metadata.name !== "praetorium-provisioner-instance-namespaces")
    .map((document) => yaml.dump(document))
    .join("---\n");
  assert.throws(() => selectAdmissionGuards(missing), /missing admission guards/u);
  assert.throws(
    () =>
      selectAdmissionGuards(
        `${bundle}\n---\n${selectedDocuments[0] && yaml.dump(selectedDocuments[0])}`,
      ),
    /duplicate admission/u,
  );
  const unknown = yaml.dump({
    apiVersion: "admissionregistration.k8s.io/v1",
    kind: "ValidatingAdmissionPolicy",
    metadata: { name: "unexpected-policy" },
    spec: {},
  });
  assert.throws(() => selectAdmissionGuards(`${bundle}\n---\n${unknown}`), /unexpected admission/u);
  assert.throws(
    () =>
      selectAdmissionGuards(
        bundle.replace(
          "  name: praetorium-provisioner-instance-namespaces",
          "   name: praetorium-provisioner-instance-namespaces",
        ),
      ),
    /malformed metadata\.name/u,
  );
});

const kustomize = spawnSync(
  process.env.PRAETORIUM_KUSTOMIZE_BIN ?? "kustomize",
  ["build", resolve(repositoryRoot, "infrastructure/kubernetes/base")],
  { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);

test(
  "actual Kustomize base bundle splits out only the 14 admission guards",
  {
    skip:
      kustomize.error || kustomize.status !== 0
        ? "standalone Kustomize is required for the Kustomize render proof"
        : false,
  },
  () => {
    const selected = selectAdmissionGuards(kustomize.stdout);
    const fullDocuments = yaml.loadAll(kustomize.stdout);
    const selectedDocuments = yaml.loadAll(selected);
    assert.equal(selectedDocuments.length, 14);
    assert.equal(
      selectedDocuments.filter((document) => document.kind === "ValidatingAdmissionPolicy").length,
      7,
    );
    assert.equal(
      selectedDocuments.filter((document) => document.kind === "ValidatingAdmissionPolicyBinding")
        .length,
      7,
    );
    assert.ok(fullDocuments.some((document) => document.kind === "ClusterRole"));
    assert.ok(fullDocuments.some((document) => document.kind === "ClusterRoleBinding"));
    assert.ok(
      selectedDocuments.every(
        (document) =>
          !["ClusterRole", "ClusterRoleBinding", "Role", "RoleBinding"].includes(document.kind),
      ),
    );
  },
);
