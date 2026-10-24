import { setTimeout as timer } from "node:timers/promises";

const API_GROUP_VERSION = "admissionregistration.k8s.io/v1";
const POLICY_KIND = "ValidatingAdmissionPolicy";
const BINDING_KIND = "ValidatingAdmissionPolicyBinding";
const PROVISIONER_USERNAME = "system:serviceaccount:praetorium-system:praetorium-provisioner";
const PROVISIONER_IDENTITY_EXPRESSION = `request.userInfo.username == ${JSON.stringify(PROVISIONER_USERNAME)}`;

const rule = (apiGroups, apiVersions, operations, resources) => ({
  apiGroups,
  apiVersions,
  operations,
  resources,
});

const namespaceRules = [rule([""], ["v1"], ["CREATE", "UPDATE", "DELETE"], ["namespaces"])];
const runtimeResourceRules = [
  rule(
    [""],
    ["v1"],
    ["CREATE", "UPDATE"],
    ["limitranges", "resourcequotas", "secrets", "serviceaccounts", "services"],
  ),
  rule(["apps"], ["v1"], ["CREATE", "UPDATE"], ["deployments"]),
  rule(["networking.k8s.io"], ["v1"], ["CREATE", "UPDATE"], ["networkpolicies"]),
  rule(["traefik.io"], ["v1alpha1"], ["CREATE", "UPDATE"], ["ingressroutes"]),
];
const runtimeResourceDeleteRules = [
  rule([""], ["v1"], ["DELETE"], ["limitranges", "resourcequotas", "secrets", "serviceaccounts", "services"]),
  rule(["apps"], ["v1"], ["DELETE"], ["deployments"]),
  rule(["networking.k8s.io"], ["v1"], ["DELETE"], ["networkpolicies"]),
  rule(["traefik.io"], ["v1alpha1"], ["DELETE"], ["ingressroutes"]),
];
const roleBindingRules = [
  rule(["rbac.authorization.k8s.io"], ["v1"], ["CREATE", "UPDATE", "DELETE"], ["rolebindings"]),
];
const ingressRouteRules = [
  rule(["traefik.io"], ["v1alpha1"], ["CREATE", "UPDATE"], ["ingressroutes"]),
];
const networkPolicyRules = [
  rule(["networking.k8s.io"], ["v1"], ["CREATE", "UPDATE"], ["networkpolicies"]),
];
const tenantPodRules = [rule([""], ["v1"], ["CREATE", "UPDATE"], ["pods"])];
const historyPvcRules = [rule([""], ["v1"], ["CREATE", "UPDATE"], ["persistentvolumeclaims"])];

function provisionerCondition(name) {
  return [{ name, expression: PROVISIONER_IDENTITY_EXPRESSION }];
}

const ADMISSION_GUARDS = [
  {
    name: "praetorium-provisioner-history-pvc",
    resourceRules: historyPvcRules,
    matchConditions: provisionerCondition("dedicated-provisioner-identity"),
  },
  {
    name: "praetorium-provisioner-instance-namespaces",
    resourceRules: namespaceRules,
    matchConditions: provisionerCondition("dedicated-provisioner-identity"),
  },
  {
    name: "praetorium-provisioner-runtime-resources",
    resourceRules: runtimeResourceRules,
    matchConditions: provisionerCondition("dedicated-provisioner-identity"),
  },
  {
    name: "praetorium-provisioner-runtime-resource-delete",
    resourceRules: runtimeResourceDeleteRules,
    matchConditions: provisionerCondition("dedicated-provisioner-identity"),
  },
  {
    name: "praetorium-provisioner-instance-rolebindings",
    resourceRules: roleBindingRules,
    matchConditions: provisionerCondition("dedicated-provisioner-identity"),
  },
  {
    name: "praetorium-provisioner-tenant-ingressroute",
    resourceRules: ingressRouteRules,
    matchConditions: provisionerCondition("provisioner-runtime-writer"),
  },
  {
    name: "praetorium-provisioner-tenant-networkpolicy",
    resourceRules: networkPolicyRules,
    matchConditions: provisionerCondition("provisioner-runtime-writer"),
  },
  {
    name: "praetorium-tenant-pods-restricted",
    resourceRules: tenantPodRules,
    namespaceSelector: {
      matchLabels: {
        "arcadia.io/platform": "arcadia-platform",
        "app.kubernetes.io/managed-by": "arcadia-provisioner",
      },
    },
  },
];

const REQUIRED_DISCOVERY_RESOURCES = [
  "validatingadmissionpolicies",
  "validatingadmissionpolicybindings",
];
const EXPECTED_POLICY_NAMES = new Set(ADMISSION_GUARDS.map(({ name }) => name));

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new Error(`Admission readiness check failed: ${message}`);
}

function normalizeExpression(expression) {
  return typeof expression === "string" ? expression.replace(/\s+/gu, " ").trim() : null;
}

function normalizeRule(value) {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const expectedKeys = ["apiGroups", "apiVersions", "operations", "resources"];
  const scopedKeys = [...expectedKeys, "scope"];
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) &&
    JSON.stringify(keys) !== JSON.stringify(scopedKeys)
  ) {
    return null;
  }
  if (
    !["apiGroups", "apiVersions", "operations", "resources"].every((key) =>
      Array.isArray(value[key]),
    )
  ) {
    return null;
  }
  if (Object.hasOwn(value, "scope") && value.scope !== "*") return null;
  return {
    apiGroups: value.apiGroups,
    apiVersions: value.apiVersions,
    operations: value.operations,
    resources: value.resources,
  };
}

function sameJson(left, right) {
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonicalize(value[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function isMatchAllSelector(selector) {
  if (!isRecord(selector)) return false;
  if (Object.keys(selector).some((key) => !["matchLabels", "matchExpressions"].includes(key))) {
    return false;
  }
  if (
    Object.hasOwn(selector, "matchLabels") &&
    (!isRecord(selector.matchLabels) || Object.keys(selector.matchLabels).length > 0)
  ) {
    return false;
  }
  if (
    Object.hasOwn(selector, "matchExpressions") &&
    (!Array.isArray(selector.matchExpressions) || selector.matchExpressions.length > 0)
  ) {
    return false;
  }
  return true;
}

function selectorIsAllowed(constraints, key, expected) {
  if (!Object.hasOwn(constraints, key)) return expected === undefined;
  if (expected !== undefined) return sameJson(constraints[key], expected);
  return isMatchAllSelector(constraints[key]);
}

function validatePolicyGuard(policy, expected) {
  if (!isRecord(policy) || policy.apiVersion !== API_GROUP_VERSION || policy.kind !== POLICY_KIND) {
    fail(`policy ${expected.name} has the wrong API version or kind`);
  }
  if (policy.metadata?.name !== expected.name) {
    fail(`policy identity mismatch for ${expected.name}`);
  }
  if (policy.metadata.deletionTimestamp !== undefined) {
    fail(`policy ${expected.name} is being deleted`);
  }
  const generation = policy.metadata?.generation;
  if (!Number.isInteger(generation) || generation < 1) {
    fail(`policy ${expected.name} has an invalid metadata.generation`);
  }
  if (!isRecord(policy.spec) || policy.spec.failurePolicy !== "Fail") {
    fail(`policy ${expected.name} must have spec.failurePolicy=Fail`);
  }
  const expectedSpecKeys = ["failurePolicy", "matchConstraints", "validations"];
  if (expected.matchConditions !== undefined) expectedSpecKeys.push("matchConditions");
  if (!sameJson(Object.keys(policy.spec).sort(), expectedSpecKeys.sort())) {
    fail(`policy ${expected.name} has an unexpected spec shape`);
  }

  const matchConstraints = policy.spec.matchConstraints;
  if (!isRecord(matchConstraints)) fail(`policy ${expected.name} has no matchConstraints`);
  const allowedConstraintKeys = [
    "matchPolicy",
    "namespaceSelector",
    "objectSelector",
    "resourceRules",
  ];
  if (
    !Object.hasOwn(matchConstraints, "resourceRules") ||
    Object.keys(matchConstraints).some((key) => !allowedConstraintKeys.includes(key))
  ) {
    fail(`policy ${expected.name} has unexpected matchConstraints fields`);
  }
  if (matchConstraints.matchPolicy !== undefined && matchConstraints.matchPolicy !== "Equivalent") {
    fail(`policy ${expected.name} has an unexpected matchPolicy`);
  }

  const actualRules = Array.isArray(matchConstraints.resourceRules)
    ? matchConstraints.resourceRules.map(normalizeRule)
    : null;
  if (!sameJson(actualRules, expected.resourceRules)) {
    fail(`policy ${expected.name} has unexpected resource rules`);
  }

  if (!selectorIsAllowed(matchConstraints, "namespaceSelector", expected.namespaceSelector)) {
    fail(`policy ${expected.name} has an unexpected namespaceSelector`);
  }
  if (!selectorIsAllowed(matchConstraints, "objectSelector", undefined)) {
    fail(`policy ${expected.name} has an unexpected objectSelector`);
  }

  const actualConditions = policy.spec.matchConditions;
  if (expected.matchConditions === undefined) {
    if (
      actualConditions !== undefined &&
      (!Array.isArray(actualConditions) || actualConditions.length > 0)
    ) {
      fail(`policy ${expected.name} has unexpected matchConditions`);
    }
  } else {
    if (
      !Array.isArray(actualConditions) ||
      actualConditions.length !== expected.matchConditions.length
    ) {
      fail(`policy ${expected.name} has unexpected matchConditions`);
    }
    const normalizedConditions = actualConditions.map((condition) => ({
      name: condition?.name,
      expression: normalizeExpression(condition?.expression),
    }));
    const normalizedExpected = expected.matchConditions.map((condition) => ({
      name: condition.name,
      expression: normalizeExpression(condition.expression),
    }));
    if (!sameJson(normalizedConditions, normalizedExpected)) {
      fail(`policy ${expected.name} has an unexpected identity match condition`);
    }
  }
}

function policyIsReady(policy, expected) {
  const generation = policy.metadata.generation;
  const status = policy.status;
  if (status === undefined || status === null) return false;
  if (!isRecord(status)) fail(`policy ${expected.name} has an invalid status object`);

  const typeChecking = status.typeChecking;
  if (typeChecking !== undefined && typeChecking !== null) {
    if (!isRecord(typeChecking)) fail(`policy ${expected.name} has an invalid typeChecking status`);
    const warnings = typeChecking.expressionWarnings;
    if (warnings !== undefined && (!Array.isArray(warnings) || warnings.length !== 0)) {
      fail(`policy ${expected.name} has type-checking expressionWarnings`);
    }
  }
  return status.observedGeneration === generation && isRecord(typeChecking);
}

function validateBinding(binding, expected) {
  if (
    !isRecord(binding) ||
    binding.apiVersion !== API_GROUP_VERSION ||
    binding.kind !== BINDING_KIND
  ) {
    fail(`binding ${expected.name} has the wrong API version or kind`);
  }
  if (binding.metadata?.name !== expected.name) {
    fail(`binding identity mismatch for ${expected.name}`);
  }
  if (binding.metadata.deletionTimestamp !== undefined) {
    fail(`binding ${expected.name} is being deleted`);
  }
  const spec = binding.spec;
  if (!isRecord(spec) || spec.policyName !== expected.name) {
    fail(`binding ${expected.name} points to the wrong policy`);
  }
  if (!Array.isArray(spec.validationActions) || !sameJson(spec.validationActions, ["Deny"])) {
    fail(`binding ${expected.name} must have only validationActions=[Deny]`);
  }
  if (Object.hasOwn(spec, "paramRef") || Object.hasOwn(spec, "matchResources")) {
    fail(`binding ${expected.name} must not parameterize or narrow policy matching`);
  }
  if (
    spec.matchConditions !== undefined &&
    (!Array.isArray(spec.matchConditions) || spec.matchConditions.length > 0)
  ) {
    fail(`binding ${expected.name} must not add match conditions`);
  }
}

function readClock(now) {
  const value = now();
  if (!Number.isFinite(value)) fail("clock returned an invalid timestamp");
  return value;
}

/** Require v1 discovery to advertise both admission resources used by this boundary. */
export function assertAdmissionApi(discovery) {
  if (
    !isRecord(discovery) ||
    discovery.apiVersion !== "v1" ||
    discovery.kind !== "APIResourceList" ||
    discovery.groupVersion !== API_GROUP_VERSION ||
    !Array.isArray(discovery.resources)
  ) {
    fail(`Kubernetes does not serve ${API_GROUP_VERSION} discovery`);
  }
  const names = new Set(discovery.resources.filter(isRecord).map((resource) => resource.name));
  const missing = REQUIRED_DISCOVERY_RESOURCES.filter((name) => !names.has(name));
  if (missing.length > 0) {
    fail(`Kubernetes discovery is missing ${missing.join(" and ")}`);
  }
}

function topLevelValues(document, key) {
  const pattern = new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, "gmu");
  return [...document.matchAll(pattern)].map((match) => match[1]);
}

function topLevelMetadataName(document) {
  const lines = document.split("\n");
  const headers = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^metadata:[ \t]*$/u.test(lines[index])) headers.push(index);
  }
  if (headers.length !== 1) return null;
  const start = headers[0] + 1;
  const names = [];
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index] !== "" && !/^[ \t]/u.test(lines[index])) break;
    const match = /^  name:[ \t]*(\S+)[ \t]*$/u.exec(lines[index]);
    if (match) names.push(match[1]);
  }
  return names.length === 1 ? names[0] : null;
}

/**
 * Extract the fixed admission phase from canonical `kubectl kustomize` YAML.
 * This deliberately recognizes only the emitter's document headers and is
 * not a generic YAML parser.
 */
export function selectAdmissionGuards(bundle) {
  if (typeof bundle !== "string" || bundle.trim() === "") {
    throw new TypeError("bundle must be a non-empty Kustomize YAML string");
  }

  const expectedPolicyNames = new Set(EXPECTED_POLICY_NAMES);
  const expectedKinds = new Set([POLICY_KIND, BINDING_KIND]);
  const foundPolicies = new Set();
  const foundBindings = new Set();
  const selected = [];

  for (const rawDocument of bundle.split(/^---[ \t]*$/mu)) {
    const document = rawDocument.trim();
    if (document === "") continue;

    const kinds = topLevelValues(document, "kind");
    if (kinds.length > 1) fail("Kustomize document has duplicate top-level kind fields");
    const kind = kinds[0];
    const metadataName = topLevelMetadataName(document);
    const candidateByKind = expectedKinds.has(kind);
    const candidateByName = expectedPolicyNames.has(metadataName);
    if (!candidateByKind && !candidateByName) continue;

    if (kind !== POLICY_KIND && kind !== BINDING_KIND) {
      fail(`admission document ${metadataName ?? "(unknown)"} has an unexpected kind`);
    }
    const apiVersions = topLevelValues(document, "apiVersion");
    if (apiVersions.length !== 1 || apiVersions[0] !== API_GROUP_VERSION) {
      fail(`admission document ${metadataName ?? "(unknown)"} has an unexpected apiVersion`);
    }
    if (metadataName === null) fail(`admission ${kind} has malformed metadata.name`);
    if (!expectedPolicyNames.has(metadataName)) {
      fail(`unexpected admission ${kind} ${metadataName}`);
    }
    const found = kind === POLICY_KIND ? foundPolicies : foundBindings;
    if (found.has(metadataName)) fail(`duplicate admission ${kind} ${metadataName}`);
    found.add(metadataName);
    selected.push(document);
  }

  const missingPolicies = [...expectedPolicyNames].filter((name) => !foundPolicies.has(name));
  const missingBindings = [...expectedPolicyNames].filter((name) => !foundBindings.has(name));
  if (missingPolicies.length > 0 || missingBindings.length > 0) {
    const missing = [
      ...missingPolicies.map((name) => `policy/${name}`),
      ...missingBindings.map((name) => `binding/${name}`),
    ];
    fail(`Kustomize bundle is missing admission guards: ${missing.join(", ")}`);
  }
  if (selected.length !== ADMISSION_GUARDS.length * 2) {
    fail("Kustomize bundle does not contain exactly seven policies and seven bindings");
  }
  return `${selected.join("\n---\n")}\n`;
}

/**
 * Wait until all source admission guards are observed and type-checked by the
 * API server. A missing read may be returned as null/undefined while apply is
 * propagating; other read errors are propagated to the caller.
 */
export async function waitForAdmissionGuards({
  readPolicy,
  readBinding,
  timeoutMs = 30_000,
  intervalMs = 250,
  now = Date.now,
  sleep = (milliseconds) => timer(milliseconds),
} = {}) {
  if (typeof readPolicy !== "function" || typeof readBinding !== "function") {
    throw new TypeError("readPolicy and readBinding must be functions");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("timeoutMs must be a finite non-negative number");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError("intervalMs must be a finite positive number");
  }
  if (typeof now !== "function" || typeof sleep !== "function") {
    throw new TypeError("now and sleep must be functions");
  }

  const deadline = readClock(now) + timeoutMs;
  let attempt = 0;
  let lastPending = [];

  while (true) {
    if (attempt > 0 && readClock(now) >= deadline) {
      fail(
        `timed out waiting for admission guards after ${timeoutMs}ms${
          lastPending.length > 0 ? `: ${lastPending.join(", ")}` : ""
        }`,
      );
    }

    const observations = await Promise.all(
      ADMISSION_GUARDS.flatMap((guard) => [
        Promise.resolve()
          .then(() => readPolicy(guard.name))
          .then((policy) => ({ type: "policy", guard, value: policy })),
        Promise.resolve()
          .then(() => readBinding(guard.name))
          .then((binding) => ({ type: "binding", guard, value: binding })),
      ]),
    );

    const policyByName = new Map();
    const bindingByName = new Map();
    for (const observation of observations) {
      const destination = observation.type === "policy" ? policyByName : bindingByName;
      destination.set(observation.guard.name, observation.value);
    }

    const pending = [];
    for (const guard of ADMISSION_GUARDS) {
      const policy = policyByName.get(guard.name);
      if (policy === null || policy === undefined) {
        pending.push(`policy/${guard.name}`);
      } else {
        validatePolicyGuard(policy, guard);
        if (!policyIsReady(policy, guard)) pending.push(`policy-status/${guard.name}`);
      }

      const binding = bindingByName.get(guard.name);
      if (binding === null || binding === undefined) {
        pending.push(`binding/${guard.name}`);
      } else {
        validateBinding(binding, guard);
      }
    }

    if (pending.length === 0) {
      if (readClock(now) > deadline) {
        fail(`timed out waiting for admission guards after ${timeoutMs}ms`);
      }
      return;
    }
    lastPending = pending;

    const remaining = deadline - readClock(now);
    if (remaining <= 0) {
      fail(`timed out waiting for admission guards after ${timeoutMs}ms: ${pending.join(", ")}`);
    }
    await sleep(Math.min(intervalMs, remaining));
    attempt += 1;
  }
}
