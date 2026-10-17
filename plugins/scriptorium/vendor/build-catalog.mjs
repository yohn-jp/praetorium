// packages/contracts/src/index.ts
var CONTRACT_VERSION = 1;
var MAX_JOB_INPUT_BYTES = 8 * 1024 * 1024;
var MAX_JOB_OUTPUT_BYTES = 8 * 1024 * 1024;
var MAX_PROPOSAL_EVIDENCE_BYTES = 1024 * 1024;

// packages/module-runtime/src/runtime-error.ts
var MODULE_IDS = ["story", "diagnostics", "nlp", "semantic", "speaker", "assistant", "publishing", "mcp"];
function isModuleId(value) {
  return typeof value === "string" && MODULE_IDS.includes(value);
}
var ModuleRuntimeError = class extends Error {
  code;
  retryable;
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "ModuleRuntimeError";
    this.code = code;
    this.retryable = retryable;
  }
};

// packages/module-runtime/src/module-plan.ts
var semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
var capabilityId = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
function boundedString(value, label, max = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value) {
    throw new ModuleRuntimeError("invalid_manifest", `Invalid ${label}`);
  }
  return value;
}
function safeEntry(value, label) {
  if (value === void 0) return void 0;
  const entry = boundedString(value, label, 1024);
  if (entry.includes("\\") || entry.includes("\0") || entry.split("/").includes("..")) {
    throw new ModuleRuntimeError("invalid_manifest", `Unsafe ${label}`);
  }
  return entry;
}
function copyManifest(value) {
  if (!value || typeof value !== "object" || !isModuleId(value.id)) {
    throw new ModuleRuntimeError("unknown_module_id", "Module manifest has an unknown ID");
  }
  const manifest = value;
  const id = manifest.id;
  if (typeof manifest.version !== "string" || !semver.test(manifest.version)) {
    throw new ModuleRuntimeError("invalid_module_version", `Module ${id} has an invalid version`);
  }
  if (manifest.contractVersion !== CONTRACT_VERSION) {
    throw new ModuleRuntimeError("contract_version_mismatch", `Module ${id} requires contract ${String(manifest.contractVersion)}; host provides ${CONTRACT_VERSION}`);
  }
  if (!Array.isArray(manifest.dependencies) || !Array.isArray(manifest.provides) || !Array.isArray(manifest.requires) || manifest.optionalRequires !== void 0 && !Array.isArray(manifest.optionalRequires) || !Array.isArray(manifest.statePaths)) {
    throw new ModuleRuntimeError("invalid_manifest", `Module ${id} has invalid dependency, capability, or state metadata`);
  }
  const dependencies = manifest.dependencies.map((dependency) => {
    if (!isModuleId(dependency)) throw new ModuleRuntimeError("unknown_module_id", `Module ${id} declares unknown dependency ${String(dependency)}`);
    return dependency;
  });
  if (new Set(dependencies).size !== dependencies.length || dependencies.includes(id)) {
    throw new ModuleRuntimeError("invalid_manifest", `Module ${id} has duplicate or self dependencies`);
  }
  const capabilities = (values, label) => {
    if (values.length > 64 || values.some((item) => typeof item !== "string" || !capabilityId.test(item))) {
      throw new ModuleRuntimeError("invalid_manifest", `Module ${id} has invalid ${label}`);
    }
    if (new Set(values).size !== values.length) throw new ModuleRuntimeError("invalid_manifest", `Module ${id} has duplicate ${label}`);
    return [...values];
  };
  if (manifest.locality !== "local" && manifest.locality !== "optional-external") {
    throw new ModuleRuntimeError("invalid_manifest", `Module ${id} has invalid locality`);
  }
  if (manifest.statePaths.length > 64 || manifest.statePaths.some((path) => typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes("..") || path.includes("\\") || path.length > 1024)) {
    throw new ModuleRuntimeError("invalid_manifest", `Module ${id} has unsafe state paths`);
  }
  const provides = capabilities(manifest.provides, "provided capabilities");
  const requires = capabilities(manifest.requires, "required capabilities");
  const optionalRequires = capabilities(manifest.optionalRequires ?? [], "optional capabilities");
  if (optionalRequires.some((capability) => requires.includes(capability) || provides.includes(capability))) {
    throw new ModuleRuntimeError("invalid_manifest", `Module ${id} repeats a provided, required, or optional capability`);
  }
  return Object.freeze({
    id,
    version: manifest.version,
    contractVersion: manifest.contractVersion,
    dependencies: Object.freeze(dependencies),
    provides: Object.freeze(provides),
    requires: Object.freeze(requires),
    optionalRequires: Object.freeze(optionalRequires),
    serverEntry: safeEntry(manifest.serverEntry, `${id} server entry`),
    browserEntry: safeEntry(manifest.browserEntry, `${id} browser entry`),
    workerEntry: safeEntry(manifest.workerEntry, `${id} worker entry`),
    statePaths: Object.freeze([...manifest.statePaths]),
    locality: manifest.locality
  });
}
function resolveModulePlan(manifests, requestedIds, hostCapabilities = []) {
  if (!Array.isArray(manifests) || manifests.length > MODULE_IDS.length) {
    throw new ModuleRuntimeError("invalid_manifest", "Module manifest set exceeds the supported module count");
  }
  const installed = /* @__PURE__ */ new Map();
  for (const raw of manifests) {
    const manifest = copyManifest(raw);
    if (installed.has(manifest.id)) throw new ModuleRuntimeError("duplicate_module_id", `Module ${manifest.id} is installed more than once`);
    installed.set(manifest.id, manifest);
  }
  const capabilityOwners = /* @__PURE__ */ new Map();
  for (const manifest of installed.values()) {
    for (const capability of manifest.provides) {
      const current = capabilityOwners.get(capability);
      if (current) throw new ModuleRuntimeError("duplicate_capability_provider", `Capability ${capability} is provided by both ${current} and ${manifest.id}`);
      capabilityOwners.set(capability, manifest.id);
    }
  }
  for (const manifest of installed.values()) {
    for (const dependency of manifest.dependencies) {
      if (!installed.has(dependency)) {
        throw new ModuleRuntimeError("missing_dependency", `Module ${manifest.id} requires installed module ${dependency}`);
      }
    }
  }
  const requested = /* @__PURE__ */ new Set();
  for (const id of requestedIds) {
    if (!isModuleId(id)) throw new ModuleRuntimeError("unknown_module_id", `Unknown module ID ${String(id)}`);
    if (!installed.has(id)) throw new ModuleRuntimeError("redeployment_required", `Module ${id} is not included in this profile; redeployment is required`);
    requested.add(id);
  }
  const enabled = /* @__PURE__ */ new Set();
  const enable = (id) => {
    if (enabled.has(id)) return;
    enabled.add(id);
    for (const dependency of installed.get(id).dependencies) enable(dependency);
  };
  for (const id of requested) enable(id);
  const ordered = [];
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new ModuleRuntimeError("dependency_cycle", `Module or capability dependency cycle includes ${id}`);
    visiting.add(id);
    const manifest = installed.get(id);
    for (const dependency of manifest.dependencies) visit(dependency);
    for (const capability of manifest.requires) {
      const provider = capabilityOwners.get(capability);
      if (provider && provider !== id && enabled.has(provider)) visit(provider);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  };
  for (const id of installed.keys()) visit(id);
  const availableCapabilities = /* @__PURE__ */ new Set();
  for (const capability of hostCapabilities) {
    if (typeof capability !== "string" || !capabilityId.test(capability)) throw new ModuleRuntimeError("invalid_capability", "Host declares an invalid capability ID");
    availableCapabilities.add(capability);
  }
  for (const capability of hostCapabilities) {
    const moduleProvider = capabilityOwners.get(capability);
    if (moduleProvider) throw new ModuleRuntimeError("duplicate_capability_provider", `Capability ${capability} is provided by both the host and ${moduleProvider}`);
  }
  for (const id of enabled) for (const capability of installed.get(id).provides) availableCapabilities.add(capability);
  for (const id of enabled) {
    const missing = installed.get(id).requires.filter((capability) => !availableCapabilities.has(capability));
    if (missing.length) throw new ModuleRuntimeError("missing_capability", `Module ${id} requires unavailable capabilities: ${missing.join(", ")}`);
  }
  return { manifests: installed, enabled, order: ordered.filter((id) => enabled.has(id)) };
}

// packages/module-runtime/src/build-catalog.ts
var DIGEST = /^sha256:[a-f0-9]{64}$/u;
var REVISION = /^[a-f0-9]{40}$/u;
var CONTRACT_RANGE = /^\^1(?:\.0(?:\.0)?)?$/u;
function fail(message) {
  throw new ModuleRuntimeError("invalid_build_catalog", message);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function equalJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function resourceAmounts(value, label) {
  if (!isRecord(value) || !hasExactKeys(value, ["cpuMilli", "memoryMiB", "ephemeralStorageMiB"])) {
    fail(`Build catalog ${label} is invalid`);
  }
  const amounts = [value.cpuMilli, value.memoryMiB, value.ephemeralStorageMiB];
  if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) {
    fail(`Build catalog ${label} is invalid`);
  }
  return {
    cpuMilli: value.cpuMilli,
    memoryMiB: value.memoryMiB,
    ephemeralStorageMiB: value.ephemeralStorageMiB
  };
}
function addResources(target, value) {
  target.cpuMilli += value.cpuMilli;
  target.memoryMiB += value.memoryMiB;
  target.ephemeralStorageMiB += value.ephemeralStorageMiB;
  if (Object.values(target).some((amount) => !Number.isSafeInteger(amount))) {
    fail("Build catalog resource total exceeds the supported integer range");
  }
}
function resolveBuildCatalogSelection(catalogValue, requestedModuleIds, trustedModules2) {
  if (!isRecord(catalogValue) || catalogValue.contractVersion !== "scriptorium-build/v1") {
    fail("Build catalog contract version is unsupported");
  }
  if (!Array.isArray(requestedModuleIds) || requestedModuleIds.length > 256 || requestedModuleIds.some((id) => typeof id !== "string") || new Set(requestedModuleIds).size !== requestedModuleIds.length) {
    fail("Requested module IDs are invalid or duplicated");
  }
  const catalog = catalogValue;
  if (!hasExactKeys(catalogValue, [
    "contractVersion",
    "producerRevision",
    "runtimeBaseDigest",
    "buildKitDigest",
    "recipeDigest",
    "lockDigest",
    "sourceDigest",
    "supportedPlatforms",
    "modules",
    "baseResources",
    "sharedResourceGroups",
    "resourceProfiles"
  ]) || !REVISION.test(catalog.producerRevision ?? "") || !DIGEST.test(catalog.runtimeBaseDigest ?? "") || !DIGEST.test(catalog.buildKitDigest ?? "") || !DIGEST.test(catalog.recipeDigest ?? "") || !DIGEST.test(catalog.lockDigest ?? "") || !DIGEST.test(catalog.sourceDigest ?? "") || !Array.isArray(catalog.supportedPlatforms) || catalog.supportedPlatforms.length === 0 || !Array.isArray(catalog.modules) || !Array.isArray(catalog.sharedResourceGroups) || !Array.isArray(catalog.resourceProfiles) || catalog.modules.length > 256 || catalog.supportedPlatforms.length > 32 || catalog.sharedResourceGroups.length > 256 || catalog.resourceProfiles.length > 256) {
    fail("Build catalog identity or collections are invalid");
  }
  const baseResources = resourceAmounts(catalog.baseResources, "base resources");
  if (new Set(catalog.supportedPlatforms).size !== catalog.supportedPlatforms.length || catalog.supportedPlatforms.some((platform) => typeof platform !== "string" || !/^[a-z0-9][a-z0-9._-]{0,31}\/[a-z0-9][a-z0-9._-]{0,31}$/u.test(platform))) {
    fail("Build catalog platforms are invalid or duplicated");
  }
  if (catalog.modules.length !== trustedModules2.length || new Set(catalog.modules.map(({ id }) => id)).size !== catalog.modules.length || new Set(trustedModules2.map(({ manifest }) => manifest.id)).size !== trustedModules2.length) {
    fail("Build catalog module set does not match the producer's shipped modules");
  }
  const trustedById = new Map(trustedModules2.map((item) => [item.manifest.id, item]));
  const catalogById = /* @__PURE__ */ new Map();
  for (const module of catalog.modules) {
    if (!isRecord(module) || !hasExactKeys(module, [
      "id",
      "version",
      "artifactDigest",
      "requires",
      "conflicts",
      "contractRange",
      "exclusiveResources",
      "sharedResourceGroupIds",
      "workerLimits"
    ]) || typeof module.id !== "string" || !isModuleId(module.id) || typeof module.version !== "string" || module.version.length === 0 || module.version.length > 512 || !DIGEST.test(module.artifactDigest) || !Array.isArray(module.requires) || !Array.isArray(module.conflicts) || !Array.isArray(module.sharedResourceGroupIds) || module.requires.length > 256 || module.conflicts.length > 256 || module.sharedResourceGroupIds.length > 256 || !isRecord(module.workerLimits) || Object.entries(module.workerLimits).some(([id, limit]) => !/^[a-z][a-zA-Z0-9]{0,63}$/u.test(id) || !Number.isSafeInteger(limit) || limit < 0)) {
      fail("Build catalog contains an invalid module descriptor");
    }
    const trusted = trustedById.get(module.id);
    if (!trusted) fail(`Build catalog includes unshipped module ${module.id}`);
    const manifest = trusted.manifest;
    const expectedRequires = [...manifest.dependencies].sort();
    const expectedConflicts = [...trusted.conflicts].sort();
    const expectedSharedGroups = [...trusted.sharedResourceGroupIds].sort();
    const expectedWorkerLimits = Object.fromEntries(Object.entries(trusted.workerLimits).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const expectedExclusiveResources = resourceAmounts(trusted.exclusiveResources, `${module.id} resources`);
    resourceAmounts(module.exclusiveResources, `${module.id} resources`);
    if (!DIGEST.test(trusted.artifactDigest) || module.version !== manifest.version || module.artifactDigest !== trusted.artifactDigest || !CONTRACT_RANGE.test(module.contractRange) || module.contractRange !== trusted.contractRange || !equalJson([...module.requires].sort(), expectedRequires) || !equalJson([...module.conflicts].sort(), expectedConflicts) || !equalJson([...module.sharedResourceGroupIds].sort(), expectedSharedGroups) || !equalJson(Object.fromEntries(Object.entries(module.workerLimits).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), expectedWorkerLimits) || !equalJson(module.exclusiveResources, expectedExclusiveResources)) {
      fail(`Build catalog descriptor for ${module.id} differs from the shipped module manifest`);
    }
    catalogById.set(module.id, module);
  }
  for (const group of catalog.sharedResourceGroups) {
    if (!isRecord(group) || !hasExactKeys(group, ["id", "resources"]) || typeof group.id !== "string" || !isModuleId(group.id)) {
      fail("Build catalog shared resource group is invalid");
    }
    resourceAmounts(group.resources, `shared group ${group.id}`);
  }
  if (new Set(catalog.sharedResourceGroups.map(({ id }) => id)).size !== catalog.sharedResourceGroups.length) {
    fail("Build catalog shared resource groups are duplicated");
  }
  if (catalog.resourceProfiles.some((profile) => !isRecord(profile) || !hasExactKeys(profile, ["id", "cpuMilli", "memoryMiB", "ephemeralStorageMiB"]) || typeof profile.id !== "string" || !isModuleId(profile.id)) || new Set(catalog.resourceProfiles.map(({ id }) => id)).size !== catalog.resourceProfiles.length) {
    fail("Build catalog resource profiles are duplicated");
  }
  for (const profile of catalog.resourceProfiles) {
    resourceAmounts({
      cpuMilli: profile.cpuMilli,
      memoryMiB: profile.memoryMiB,
      ephemeralStorageMiB: profile.ephemeralStorageMiB
    }, `resource profile ${profile.id}`);
  }
  const plan = resolveModulePlan(trustedModules2.map(({ manifest }) => manifest), requestedModuleIds);
  const selected = new Set(plan.enabled);
  for (const moduleId of selected) {
    const module = catalogById.get(moduleId);
    if (!module) fail(`Build catalog does not provide selected module ${moduleId}`);
    for (const conflict of module.conflicts) {
      if (selected.has(conflict)) {
        fail(`Selected modules ${moduleId} and ${conflict} conflict`);
      }
    }
  }
  const resources = { ...baseResources };
  const sharedGroupIds = /* @__PURE__ */ new Set();
  const resolvedModules = [...selected].sort().map((id) => {
    const module = catalogById.get(id);
    addResources(resources, resourceAmounts(module.exclusiveResources, `${id} resources`));
    for (const groupId of module.sharedResourceGroupIds) sharedGroupIds.add(groupId);
    return { id, version: module.version, artifactDigest: module.artifactDigest };
  });
  const sharedGroups = new Map(catalog.sharedResourceGroups.map(({ id, resources: amounts }) => [id, amounts]));
  for (const id of [...sharedGroupIds].sort()) {
    const amounts = sharedGroups.get(id);
    if (!amounts) fail(`Build catalog is missing shared resource group ${id}`);
    addResources(resources, resourceAmounts(amounts, `shared group ${id}`));
  }
  return {
    requestedModules: [...new Set(requestedModuleIds)].sort(),
    resolvedModules,
    resourceRequirements: resources,
    moduleOrder: [...plan.order]
  };
}

// scripts/composition-persistence.mjs
var baseReadablePersistence = [
  { formatId: "scriptorium.browser-recovery-indexeddb", version: 3 },
  { formatId: "scriptorium.git-operations", version: 1 },
  { formatId: "scriptorium.git-proposal-binding", version: 2 },
  { formatId: "scriptorium.git-proposal-complete", version: 2 },
  { formatId: "scriptorium.git-proposal-legacy", version: 1 },
  { formatId: "scriptorium.git-publications", version: 1 }
];
var baseWritablePersistence = [
  { formatId: "scriptorium.browser-recovery-indexeddb", version: 3 },
  { formatId: "scriptorium.git-operations", version: 1 },
  { formatId: "scriptorium.git-proposal-binding", version: 2 },
  { formatId: "scriptorium.git-proposal-complete", version: 2 },
  { formatId: "scriptorium.git-publications", version: 1 }
];
function persistenceForModules(selectedModuleIds, moduleFormats) {
  const selected = new Set(selectedModuleIds);
  if (selected.size !== selectedModuleIds.length) throw new Error("Selected module IDs must be unique for persistence declarations");
  const readable = new Map(baseReadablePersistence.map(({ formatId, version }) => [formatId, /* @__PURE__ */ new Set([version])]));
  const writable = new Map(baseWritablePersistence.map(({ formatId, version }) => [formatId, /* @__PURE__ */ new Set([version])]));
  for (const descriptor of moduleFormats) {
    if (!selected.has(descriptor.moduleId)) continue;
    if (!Number.isSafeInteger(descriptor.version) || descriptor.version < 1 || typeof descriptor.formatId !== "string" || descriptor.formatId.length === 0 || typeof descriptor.readable !== "boolean" || typeof descriptor.writable !== "boolean") {
      throw new Error(`Invalid persistence descriptor for selected module ${descriptor.moduleId}`);
    }
    if (descriptor.readable) {
      const versions = readable.get(descriptor.formatId) ?? /* @__PURE__ */ new Set();
      versions.add(descriptor.version);
      readable.set(descriptor.formatId, versions);
    }
    if (descriptor.writable) {
      const versions = writable.get(descriptor.formatId) ?? /* @__PURE__ */ new Set();
      versions.add(descriptor.version);
      writable.set(descriptor.formatId, versions);
    }
  }
  const readableDeclarations = [...readable].map(([formatId, versions]) => ({ formatId, versions: [...versions].sort((left, right) => left - right) })).sort((left, right) => left.formatId < right.formatId ? -1 : left.formatId > right.formatId ? 1 : 0);
  const writableDeclarations = [...writable].flatMap(([formatId, versions]) => [...versions].map((version) => ({ formatId, version }))).sort((left, right) => left.formatId < right.formatId ? -1 : left.formatId > right.formatId ? 1 : left.version - right.version);
  return { contractVersion: "scriptorium-persistence/v1", readable: readableDeclarations, writable: writableDeclarations };
}

// packages/module-runtime/src/persistence-formats.ts
var format = (moduleId, name, path, content, readable, writable, options = {}) => ({
  moduleId,
  formatId: `scriptorium.module-${moduleId}.${name}`,
  version: 1,
  paths: [{ kind: options.prefix ? "prefix" : "exact", path }],
  content,
  readable,
  writable,
  ...options.preserveOnly ? { preserveOnly: true } : {}
});
var preserved = (moduleId, name, path) => format(moduleId, name, path, "opaque", false, false, { prefix: true, preserveOnly: true });
var MODULE_PERSISTENCE_FORMATS = [
  format("assistant", "model-settings", "meta/scriptorium/modules/assistant/model-settings.json", "json", true, true),
  format("assistant", "usage", "meta/scriptorium/modules/assistant/usage.jsonl", "jsonl", true, true),
  preserved("assistant", "legacy-files", "meta/scriptorium/modules/assistant/legacy/files/"),
  format("diagnostics", "lint-rules", "meta/scriptorium/modules/diagnostics/lint-rules.yaml", "text", true, true),
  format("diagnostics", "tone-lexicon", "meta/scriptorium/modules/diagnostics/tone-lexicon.yaml", "text", true, true),
  format("diagnostics", "plot-lexicon", "meta/scriptorium/modules/diagnostics/plot-lexicon.yaml", "text", true, true),
  preserved("diagnostics", "legacy-files", "meta/scriptorium/modules/diagnostics/legacy/files/"),
  format("nlp", "synonyms", "meta/scriptorium/modules/nlp/synonyms.yaml", "text", true, true),
  format("nlp", "candidate-ignore-list", "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml", "text", true, true),
  format("nlp", "feature-settings", "meta/scriptorium/modules/nlp/feature-settings.json", "json", true, true),
  preserved("nlp", "legacy-files", "meta/scriptorium/modules/nlp/legacy/files/"),
  format("publishing", "episodes", "meta/scriptorium/modules/publishing/episodes.yaml", "text", true, true),
  format("publishing", "share-grants", "meta/scriptorium/modules/publishing/share-grants.jsonl", "jsonl", true, true),
  format("publishing", "cover", "meta/scriptorium/modules/publishing/assets/cover.jpg", "binary", true, false),
  preserved("publishing", "legacy-files", "meta/scriptorium/modules/publishing/legacy/files/"),
  format("publishing", "legacy-share-grants", "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl", "jsonl", true, false),
  format("semantic", "settings", "meta/scriptorium/modules/semantic/settings.json", "json", true, true),
  format("semantic", "contradiction-dismissals", "meta/scriptorium/modules/semantic/contradiction-dismissals.jsonl", "jsonl", true, true),
  preserved("semantic", "legacy-files", "meta/scriptorium/modules/semantic/legacy/files/"),
  format("speaker", "corrections", "meta/scriptorium/modules/speaker/corrections.jsonl", "jsonl", true, true),
  format("speaker", "adopted-model", "meta/scriptorium/modules/speaker/adopted-model.json", "json", true, true),
  preserved("speaker", "legacy-files", "meta/scriptorium/modules/speaker/legacy/files/"),
  format("story", "series", "meta/scriptorium/modules/story/v1/series.json", "json", true, true),
  format("story", "state-proposals", "meta/scriptorium/modules/story/state-proposals.jsonl", "jsonl", true, true),
  format("story", "zukan-suggestions", "meta/scriptorium/modules/story/zukan-suggestions.jsonl", "jsonl", true, true),
  preserved("story", "change-sets", "meta/scriptorium/modules/story/change-sets/"),
  preserved("story", "local-snapshots", "meta/scriptorium/modules/story/local-snapshots/"),
  preserved("story", "legacy-sqlite", "meta/scriptorium/modules/story/legacy/sqlite/"),
  preserved("story", "legacy-files", "meta/scriptorium/modules/story/legacy/files/")
];

// buildkit/.build-catalog-entry.mjs
var trustedModules = JSON.parse('[{"artifactDigest":"sha256:b4ccb79a62b04859dd67baaf8a2a43d1f496cf2861d5b02f615199e71d12526c","conflicts":[],"contractRange":"^1","exclusiveResources":{"cpuMilli":0,"ephemeralStorageMiB":0,"memoryMiB":0},"manifest":{"browserEntry":"./dist/browser.js","contractVersion":1,"dependencies":[],"id":"story","locality":"local","optionalRequires":["nlp.tokenizer"],"provides":[],"requires":[],"serverEntry":"./dist/index.js","statePaths":["bible","plot","manuscript","meta/scriptorium/modules/story"],"version":"0.1.0"},"sharedResourceGroupIds":[],"workerLimits":{}},{"artifactDigest":"sha256:b4959430f2f6f00106e6ceddd48546a84c9e5ca1986d3f83c8185afaf144e577","conflicts":[],"contractRange":"^1","exclusiveResources":{"cpuMilli":0,"ephemeralStorageMiB":0,"memoryMiB":0},"manifest":{"browserEntry":"./dist/browser.js","contractVersion":1,"dependencies":["nlp"],"id":"diagnostics","locality":"local","optionalRequires":["semantic.embedding"],"provides":[],"requires":["nlp.tokenizer"],"serverEntry":"./dist/index.js","statePaths":["meta/scriptorium/modules/diagnostics"],"version":"0.1.0","workerEntry":"./dist/worker.js"},"sharedResourceGroupIds":[],"workerLimits":{}},{"artifactDigest":"sha256:410539bbacccdb3a3bf7576d8db65ef19d46328dcb9c928237bd24afcccb858f","conflicts":[],"contractRange":"^1","exclusiveResources":{"cpuMilli":0,"ephemeralStorageMiB":0,"memoryMiB":0},"manifest":{"browserEntry":"./dist/browser.js","contractVersion":1,"dependencies":[],"id":"nlp","locality":"local","provides":["nlp.tokenizer","nlp.token-counter"],"requires":[],"serverEntry":"./dist/index.js","statePaths":["meta/scriptorium/modules/nlp"],"version":"0.1.0","workerEntry":"./dist/worker.js"},"sharedResourceGroupIds":[],"workerLimits":{}},{"artifactDigest":"sha256:01ec4086a11ad171b171777ec2644fa22fbf1afc6979ae34b391eccdfa299788","conflicts":[],"contractRange":"^1","exclusiveResources":{"cpuMilli":0,"ephemeralStorageMiB":0,"memoryMiB":0},"manifest":{"browserEntry":"./dist/browser.js","contractVersion":1,"dependencies":["story","nlp"],"id":"semantic","locality":"local","provides":["semantic.embedding"],"requires":["nlp.tokenizer"],"serverEntry":"./dist/index.js","statePaths":["meta/scriptorium/modules/semantic"],"version":"0.1.0","workerEntry":"./dist/worker.js"},"sharedResourceGroupIds":[],"workerLimits":{}},{"artifactDigest":"sha256:85f5785c13c9bcd31ca31224a00a9155cdd13b6f626c720979f03e0813fb8987","conflicts":[],"contractRange":"^1","exclusiveResources":{"cpuMilli":0,"ephemeralStorageMiB":0,"memoryMiB":0},"manifest":{"browserEntry":"./dist/browser.js","contractVersion":1,"dependencies":["story","nlp","diagnostics"],"id":"speaker","locality":"local","provides":[],"requires":["nlp.tokenizer"],"serverEntry":"./dist/index.js","statePaths":["meta/scriptorium/modules/speaker","plot/volumes"],"version":"0.1.0","workerEntry":"./dist/worker.js"},"sharedResourceGroupIds":[],"workerLimits":{}},{"artifactDigest":"sha256:4e3a4b9078ac1b2699305ace137286b282863f8f60e364c4feac2596fc7fcde1","conflicts":[],"contractRange":"^1","exclusiveResources":{"cpuMilli":0,"ephemeralStorageMiB":0,"memoryMiB":0},"manifest":{"browserEntry":"./dist/browser.js","contractVersion":1,"dependencies":["story","nlp","diagnostics","semantic","speaker"],"id":"assistant","locality":"optional-external","optionalRequires":["host.model-usage","nlp.token-counter"],"provides":[],"requires":[],"serverEntry":"./dist/index.js","statePaths":["meta/scriptorium/modules/assistant"],"version":"0.1.0"},"sharedResourceGroupIds":[],"workerLimits":{}},{"artifactDigest":"sha256:88c436aa0b4537e221d662ddba0cd51a7fc156a15b96fa894603adff2fe7fc5c","conflicts":[],"contractRange":"^1","exclusiveResources":{"cpuMilli":0,"ephemeralStorageMiB":0,"memoryMiB":0},"manifest":{"browserEntry":"./dist/browser.js","contractVersion":1,"dependencies":[],"id":"publishing","locality":"local","provides":[],"requires":[],"serverEntry":"./dist/index.js","statePaths":["meta/scriptorium/modules/publishing"],"version":"0.1.0"},"sharedResourceGroupIds":[],"workerLimits":{}},{"artifactDigest":"sha256:8ae7cd4b613fed01c82228a1843148d06293742d6ba21261d3a98106f6e5c284","conflicts":[],"contractRange":"^1","exclusiveResources":{"cpuMilli":0,"ephemeralStorageMiB":0,"memoryMiB":0},"manifest":{"contractVersion":1,"dependencies":[],"id":"mcp","locality":"local","provides":[],"requires":[],"serverEntry":"./dist/index.js","statePaths":[],"version":"0.1.0"},"sharedResourceGroupIds":[],"workerLimits":{}}]');
function resolveBuildCatalogSelection2(catalog, requestedModuleIds) {
  return resolveBuildCatalogSelection(catalog, requestedModuleIds, trustedModules);
}
function resolveCompositionPersistence(selectedModuleIds) {
  return persistenceForModules(selectedModuleIds, MODULE_PERSISTENCE_FORMATS);
}
export {
  resolveBuildCatalogSelection2 as resolveBuildCatalogSelection,
  resolveCompositionPersistence
};
