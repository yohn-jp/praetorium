import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createSecureContext } from "node:tls";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  InClusterKubernetesTransport,
  KubernetesApiClient,
  KubernetesApiError,
  KubernetesRuntimeProvider,
  CLUSTER_LABEL_KEY,
  MANAGED_BY_LABEL_KEY,
  MANAGED_BY_LABEL_VALUE,
  OWNERSHIP_LABEL_KEY,
  OWNERSHIP_VERSION,
  PLATFORM_LABEL_KEY,
  PLATFORM_LABEL_VALUE,
  REPOSITORY_LABEL_KEY,
  createKubernetesResourceRenderer,
  parseRuntimeInstanceId,
  parseRuntimeReleaseId,
  parseRuntimeRepositoryId,
} from "../../plugins/kubernetes/dist/index.js";

const CATEGORY = "kubernetes-isolation";
const INVENTORY_ENV = "PRAETORIUM_T14_INVENTORY_PATH";
const RUNNER_CATEGORY_ENV = "PRAETORIUM_T14_CATEGORY";
const CONTROL_PROBE_NAMESPACE = "praetorium-observability";
const MAX_FILE_BYTES = 64 * 1024;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const INSTANCE_LABEL = "arcadia.io/instance-id";
const APP_LABEL = "app.kubernetes.io/name";
const RUN_LABEL = "praetorium.io/t14-run-id";
const INVENTORY_LABEL = "praetorium.io/t14-inventory-id";
const PROBE_APP_LABEL = "praetorium.io/t14-probe";
const APP_READY_PATH = "/readyz";
const APP_HEALTH_PATH = "/healthz";
const APP_AUTH_PATH = "/__t14/auth";
const APP_INGRESS_PATH = "/__t14/ingress";
const PROBE_HTTP_PORT = 8080;
const PROBE_AUTH_VALUE = "t14-owned-probe-auth-v1";
const PROBE_READY_MARKER = "t14-probe-ready-v1";
const PROBE_AUTH_MARKER = "t14-probe-auth-ok-v1";
const PROBE_INGRESS_MARKER = "t14-probe-ingress-ok-v1";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected, field, errors) {
  if (!isRecord(value)) {
    errors.push(`${field} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    errors.push(`${field} must contain exactly: ${wanted.join(", ")}`);
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeAbsolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

function safeResourceQuantities(value, field, errors) {
  exactKeys(value, ["cpuMilli", "memoryMiB", "ephemeralStorageMiB"], field, errors);
  for (const key of ["cpuMilli", "memoryMiB", "ephemeralStorageMiB"]) {
    if (!Number.isSafeInteger(value?.[key]) || value[key] < 1) {
      errors.push(`${field}.${key} must be a positive safe integer`);
    }
  }
}

function validateConfig(config, inventory, now = Date.now()) {
  const errors = [];
  exactKeys(
    config,
    ["schemaVersion", "inventory", "cluster", "credentials", "probe", "network", "timeouts"],
    "config",
    errors,
  );
  if (config?.schemaVersion !== 1) errors.push("config.schemaVersion must be 1");

  exactKeys(
    config?.inventory,
    ["inventoryId", "ownerIdentity", "environmentName", "expiresAt"],
    "config.inventory",
    errors,
  );
  for (const key of ["inventoryId", "ownerIdentity", "environmentName", "expiresAt"]) {
    if (!nonEmpty(config?.inventory?.[key])) errors.push(`config.inventory.${key} is required`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(config?.inventory?.inventoryId ?? "")) {
    errors.push("config.inventory.inventoryId must be a safe Kubernetes label value");
  }
  if (config?.inventory?.inventoryId !== inventory?.inventoryId) {
    errors.push("config.inventory.inventoryId must match the acceptance inventory");
  }
  if (config?.inventory?.ownerIdentity !== inventory?.owner?.identity) {
    errors.push("config.inventory.ownerIdentity must match the acceptance inventory owner");
  }
  if (config?.inventory?.environmentName !== inventory?.environment?.name) {
    errors.push("config.inventory.environmentName must match the acceptance inventory environment");
  }
  if (config?.inventory?.expiresAt !== inventory?.environment?.expiresAt) {
    errors.push("config.inventory.expiresAt must match the acceptance inventory expiry");
  }

  exactKeys(
    config?.cluster,
    [
      "id",
      "provider",
      "name",
      "context",
      "confirmation",
      "apiHost",
      "apiPort",
      "namespacePrefix",
      "ingressNamespace",
      "instanceAccessNamespace",
      "maximumResources",
      "resourceProfile",
    ],
    "config.cluster",
    errors,
  );
  if (!/^clu_[0-9A-HJKMNP-TV-Z]{26}$/u.test(config?.cluster?.id ?? "")) {
    errors.push("config.cluster.id must be an opaque Kubernetes cluster identifier");
  }
  if (config?.cluster?.provider !== "kind") errors.push("config.cluster.provider must be kind");
  if (!/^praetorium-t14-[a-z0-9-]{1,23}[a-z0-9]$/u.test(config?.cluster?.name ?? "")) {
    errors.push("config.cluster.name must identify an explicitly disposable T14 Kind cluster");
  }
  if (config?.cluster?.context !== `kind-${config?.cluster?.name}`) {
    errors.push("config.cluster.context must be the exact Kind context for the cluster name");
  }
  if (config?.cluster?.confirmation !== config?.cluster?.name) {
    errors.push("config.cluster.confirmation must repeat the explicit disposable cluster name");
  }
  if (
    isIP(config?.cluster?.apiHost ?? "") === 0 ||
    !["127.0.0.1", "::1"].includes(config.cluster.apiHost)
  ) {
    errors.push(
      "config.cluster.apiHost must be an explicit loopback IP for the local disposable API",
    );
  }
  if (
    !Number.isSafeInteger(config?.cluster?.apiPort) ||
    config.cluster.apiPort < 1 ||
    config.cluster.apiPort > 65_535
  ) {
    errors.push("config.cluster.apiPort must be a valid explicit TCP port");
  }
  if (config?.cluster?.namespacePrefix !== "praetorium-instances") {
    errors.push(
      "config.cluster.namespacePrefix must match the deployed tenant namespace admission prefix",
    );
  }
  if (config?.cluster?.ingressNamespace !== "traefik") {
    errors.push(
      "config.cluster.ingressNamespace must match the deployed tenant ingress policy namespace",
    );
  }
  if (config?.cluster?.instanceAccessNamespace !== "praetorium-system") {
    errors.push("config.cluster.instanceAccessNamespace must match the deployed peer namespace");
  }
  safeResourceQuantities(
    config?.cluster?.maximumResources,
    "config.cluster.maximumResources",
    errors,
  );
  exactKeys(
    config?.cluster?.resourceProfile,
    ["id", "cpuMilli", "memoryMiB", "ephemeralStorageMiB"],
    "config.cluster.resourceProfile",
    errors,
  );
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(config?.cluster?.resourceProfile?.id ?? "")) {
    errors.push("config.cluster.resourceProfile.id is invalid");
  }
  const limits = config?.cluster?.maximumResources;
  const profile = config?.cluster?.resourceProfile;
  for (const key of ["cpuMilli", "memoryMiB", "ephemeralStorageMiB"]) {
    if (
      Number.isSafeInteger(profile?.[key]) &&
      Number.isSafeInteger(limits?.[key]) &&
      profile[key] > limits[key]
    ) {
      errors.push(`config.cluster.resourceProfile.${key} must not exceed maximumResources`);
    }
  }

  exactKeys(
    config?.credentials,
    ["directory", "controllerTokenPath", "providerTokenPath", "caPath"],
    "config.credentials",
    errors,
  );
  for (const key of ["directory", "controllerTokenPath", "providerTokenPath", "caPath"]) {
    if (!safeAbsolutePath(config?.credentials?.[key])) {
      errors.push(`config.credentials.${key} must be an absolute path`);
    }
  }

  exactKeys(
    config?.probe,
    ["repositoryId", "imageRef", "imageDigest", "platformManifestDigest", "httpPort"],
    "config.probe",
    errors,
  );
  if (!Number.isSafeInteger(config?.probe?.repositoryId) || config.probe.repositoryId < 1) {
    errors.push("config.probe.repositoryId must be an explicit numeric test repository identity");
  }
  const imageRef = config?.probe?.imageRef;
  const imageDigest = config?.probe?.imageDigest;
  const platformDigest = config?.probe?.platformManifestDigest;
  if (
    typeof imageRef !== "string" ||
    !/^[a-z0-9][a-z0-9./:_-]{0,254}@sha256:[0-9a-f]{64}$/u.test(imageRef) ||
    !DIGEST.test(imageDigest ?? "") ||
    !imageRef.endsWith(`@${imageDigest}`) ||
    !DIGEST.test(platformDigest ?? "")
  ) {
    errors.push(
      "config.probe must name an immutable image reference, index digest, and platform digest",
    );
  }
  if (
    !Number.isSafeInteger(config?.probe?.httpPort) ||
    config.probe.httpPort < 1024 ||
    config.probe.httpPort > 65_535
  ) {
    errors.push("config.probe.httpPort must be a non-privileged TCP port");
  }

  exactKeys(
    config?.network,
    [
      "hostnameSuffix",
      "ingressAddress",
      "ingressPort",
      "ingressCaPath",
      "publicEgressUrl",
      "publicEgressMarker",
    ],
    "config.network",
    errors,
  );
  if (!DOMAIN.test(config?.network?.hostnameSuffix ?? "")) {
    errors.push(
      "config.network.hostnameSuffix must be a DNS suffix owned by this test environment",
    );
  }
  if (isIP(config?.network?.ingressAddress ?? "") === 0) {
    errors.push("config.network.ingressAddress must be an explicit ingress IP address");
  }
  if (
    !Number.isSafeInteger(config?.network?.ingressPort) ||
    config.network.ingressPort < 1 ||
    config.network.ingressPort > 65_535
  ) {
    errors.push("config.network.ingressPort must be a valid explicit TCP port");
  }
  if (!safeAbsolutePath(config?.network?.ingressCaPath)) {
    errors.push("config.network.ingressCaPath must be an absolute path");
  }
  let publicEgress;
  try {
    publicEgress = new URL(config?.network?.publicEgressUrl);
  } catch {
    errors.push("config.network.publicEgressUrl must be a public HTTPS URL");
  }
  if (
    publicEgress &&
    (publicEgress.protocol !== "https:" ||
      (publicEgress.port !== "" && publicEgress.port !== "443") ||
      publicEgress.username !== "" ||
      publicEgress.password !== "" ||
      publicEgress.search !== "" ||
      publicEgress.hash !== "" ||
      isIP(publicEgress.hostname) !== 0 ||
      /(?:^|\.)(?:localhost|local|internal|invalid)$/iu.test(publicEgress.hostname))
  ) {
    errors.push(
      "config.network.publicEgressUrl must be a public HTTPS hostname on port 443 without credentials or fragment",
    );
  }
  if (
    !nonEmpty(config?.network?.publicEgressMarker) ||
    config.network.publicEgressMarker.length > 128 ||
    /[\r\n\0]/u.test(config.network.publicEgressMarker)
  ) {
    errors.push("config.network.publicEgressMarker must be a bounded single-line response marker");
  }

  exactKeys(
    config?.timeouts,
    ["requestMs", "readinessMs", "networkProbeMs", "totalMs"],
    "config.timeouts",
    errors,
  );
  const timeoutBounds = {
    requestMs: [1_000, 20_000],
    readinessMs: [10_000, 600_000],
    networkProbeMs: [2_000, 30_000],
    totalMs: [60_000, 1_200_000],
  };
  for (const [key, [min, max]] of Object.entries(timeoutBounds)) {
    if (
      !Number.isSafeInteger(config?.timeouts?.[key]) ||
      config.timeouts[key] < min ||
      config.timeouts[key] > max
    ) {
      errors.push(`config.timeouts.${key} must be between ${min} and ${max} milliseconds`);
    }
  }
  const expiresAt = Date.parse(inventory?.environment?.expiresAt ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now)
    errors.push("owned T14 inventory has expired");
  if (
    Number.isSafeInteger(config?.timeouts?.totalMs) &&
    Number.isFinite(expiresAt) &&
    expiresAt <= now + config.timeouts.totalMs + 60_000
  ) {
    errors.push("owned T14 inventory expiry must outlast the full bounded test and cleanup window");
  }
  return [...new Set(errors)];
}

function validateInventory(inventory, now = Date.now()) {
  const errors = [];
  if (!isRecord(inventory) || inventory.schemaVersion !== 1)
    errors.push("acceptance inventory schemaVersion must be 1");
  if (!nonEmpty(inventory?.inventoryId)) errors.push("acceptance inventory ID is required");
  const ownerIdentity = inventory?.owner?.identity;
  if (
    !nonEmpty(ownerIdentity) ||
    /^(?:unassigned|unknown|todo|fixture|example|not[- ]configured|operator-supplied before provisioning)$/iu.test(
      ownerIdentity.trim(),
    )
  ) {
    errors.push("acceptance inventory owner identity has not been supplied");
  }
  const environment = inventory?.environment;
  if (environment?.purpose !== "t14-disposable-test")
    errors.push("acceptance inventory purpose must be t14-disposable-test");
  if (environment?.disposable !== true)
    errors.push("acceptance inventory must explicitly be disposable");
  if (environment?.production !== false)
    errors.push("acceptance inventory must explicitly be nonproduction");
  const expiry = Date.parse(environment?.expiresAt ?? "");
  if (!Number.isFinite(expiry) || expiry <= now)
    errors.push("acceptance inventory has expired or has no explicit expiry");
  const resource = inventory?.resources?.[CATEGORY];
  if (resource?.state !== "available")
    errors.push("owned disposable Kubernetes cluster is missing");
  if (resource?.owner !== ownerIdentity)
    errors.push("Kubernetes resource owner must match inventory owner");
  if (resource?.disposable !== true || resource?.production !== false) {
    errors.push("Kubernetes resource must be explicitly disposable and nonproduction");
  }
  if (!safeAbsolutePath(resource?.reference)) {
    errors.push("Kubernetes resource reference must be an absolute private config path");
  }
  return [...new Set(errors)];
}

function assertValidInventory(inventory) {
  const errors = validateInventory(inventory);
  assert.deepEqual(errors, [], `T14 inventory is not runnable: ${errors.join("; ")}`);
}

function assertValidConfig(config, inventory) {
  const errors = validateConfig(config, inventory);
  assert.deepEqual(errors, [], `T14 private config is invalid: ${errors.join("; ")}`);
}

async function readJsonFile(file, { privateFile = false, maximumBytes = MAX_FILE_BYTES } = {}) {
  const absolute = path.resolve(file);
  const linkInfo = await lstat(absolute);
  assert.ok(
    linkInfo.isFile() && !linkInfo.isSymbolicLink(),
    `${privateFile ? "private config" : "inventory"} must be a regular file`,
  );
  assert.ok(linkInfo.size > 0 && linkInfo.size <= maximumBytes, "JSON input has an invalid size");
  if (typeof process.getuid === "function") {
    assert.equal(
      linkInfo.uid,
      process.getuid(),
      "JSON input must be owned by the current operator",
    );
  }
  if (privateFile) {
    assert.equal(
      linkInfo.mode & 0o077,
      0,
      "private runner config must not be readable by group or other users",
    );
  }
  const contents = await readFile(absolute, "utf8");
  return JSON.parse(contents);
}

async function validateCredentialFiles(config) {
  const root = await realpath(config.credentials.directory);
  const rootInfo = await stat(root);
  assert.ok(rootInfo.isDirectory(), "credential directory must resolve to a directory");
  if (typeof process.getuid === "function")
    assert.equal(
      rootInfo.uid,
      process.getuid(),
      "credential directory must be owned by the current operator",
    );
  assert.equal(
    rootInfo.mode & 0o077,
    0,
    "credential directory must be private to the current operator",
  );

  const controllerTokenRealPath = await realpath(config.credentials.controllerTokenPath);
  const providerTokenRealPath = await realpath(config.credentials.providerTokenPath);
  const caRealPath = await realpath(config.credentials.caPath);
  for (const [label, file] of [
    ["controller token", controllerTokenRealPath],
    ["Provisioner ServiceAccount token", providerTokenRealPath],
    ["API CA", caRealPath],
    ["ingress CA", await realpath(config.network.ingressCaPath)],
  ]) {
    assert.ok(
      file.startsWith(`${root}${path.sep}`),
      `${label} must resolve below the private credential directory`,
    );
    const info = await stat(file);
    assert.ok(info.isFile(), `${label} must resolve to a regular file`);
    assert.ok(info.size > 0 && info.size <= 128 * 1024, `${label} size is outside bounds`);
    if (typeof process.getuid === "function")
      assert.equal(info.uid, process.getuid(), `${label} must be owned by the current operator`);
    if (label.endsWith("token"))
      assert.equal(info.mode & 0o077, 0, `${label} must be private to the current operator`);
    else assert.equal(info.mode & 0o022, 0, `${label} must not be group/other writable`);
  }
  const [controllerToken, providerToken] = await Promise.all([
    readFile(controllerTokenRealPath, "utf8"),
    readFile(providerTokenRealPath, "utf8"),
  ]).then((tokens) => tokens.map((token) => token.trim()));
  for (const [label, token] of [
    ["controller", controllerToken],
    ["Provisioner ServiceAccount", providerToken],
  ]) {
    assert.ok(
      token.length > 0 && token.length <= 16_384 && !/\s/u.test(token),
      `${label} Kubernetes API bearer token is invalid`,
    );
  }
  assert.notEqual(
    controllerToken,
    providerToken,
    "test-controller and product ServiceAccount credentials must be distinct",
  );
  const apiCa = await readFile(caRealPath);
  const ingressCa = await readFile(await realpath(config.network.ingressCaPath));
  createSecureContext({ ca: apiCa });
  createSecureContext({ ca: ingressCa });
  return {
    controllerTokenPath: controllerTokenRealPath,
    providerTokenPath: providerTokenRealPath,
    caPath: caRealPath,
    ingressCa,
  };
}

async function loadOwnedInputs() {
  const inventoryPath = process.env[INVENTORY_ENV];
  assert.ok(
    safeAbsolutePath(inventoryPath),
    `${INVENTORY_ENV} must name the explicit acceptance inventory`,
  );
  assert.equal(
    process.env[RUNNER_CATEGORY_ENV],
    CATEGORY,
    `${RUNNER_CATEGORY_ENV} must select ${CATEGORY}`,
  );
  const inventory = await readJsonFile(inventoryPath);
  assertValidInventory(inventory);
  const resource = inventory.resources[CATEGORY];
  const config = await readJsonFile(resource.reference, { privateFile: true });
  assertValidConfig(config, inventory);
  const credentialFiles = await validateCredentialFiles(config);
  return { inventory, config, credentialFiles };
}

function crockfordId() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = "";
  for (const byte of randomBytes(26)) value += alphabet[byte & 31];
  return `ins_${value}`;
}

function runId() {
  return randomBytes(10).toString("hex");
}

function runtimeNamespace(prefix, instanceId) {
  return `${prefix}-${instanceId.slice(4).toLowerCase()}`;
}

function runtimeService(instanceId) {
  return `arcadia-${instanceId.replace("_", "-").toLowerCase()}`;
}

function runtimeSpec(config, instanceId, hostSuffix) {
  const repositoryId = parseRuntimeRepositoryId(config.probe.repositoryId);
  const releaseId = parseRuntimeReleaseId(`t14-${randomBytes(12).toString("hex")}`);
  return {
    instanceId: parseRuntimeInstanceId(instanceId),
    repositoryId,
    runtimeEpoch: 1,
    generation: 1,
    clusterId: config.cluster.id,
    release: {
      releaseId,
      artifactRef: config.probe.imageRef,
      imageDigest: config.probe.imageDigest,
      platformManifestDigest: config.probe.platformManifestDigest,
    },
    resourceProfile: {
      id: config.cluster.resourceProfile.id,
      request: {
        cpuMilli: config.cluster.resourceProfile.cpuMilli,
        memoryMiB: config.cluster.resourceProfile.memoryMiB,
        ephemeralStorageMiB: config.cluster.resourceProfile.ephemeralStorageMiB,
      },
    },
    hostname: `ins-${instanceId.slice(4).toLowerCase()}.${hostSuffix}`,
    runtimeConfig: {},
    application: {
      httpPort: config.probe.httpPort,
      livenessPath: APP_HEALTH_PATH,
      readinessPath: APP_READY_PATH,
      metadataPath: "/__t14/metadata",
      shutdownPath: "/__t14/shutdown",
      shutdownTimeoutSeconds: 30,
      platformControlPaths: {
        status: "/__t14/status",
        quiesce: "/__t14/quiesce",
        resume: "/__t14/resume",
      },
    },
  };
}

class TestControllerReservations {
  #clusterId;
  #reservations;
  #snapshot;

  constructor(clusterId, specs) {
    this.#clusterId = clusterId;
    this.#reservations = specs.map((spec, index) => ({
      reservationId: `t14-controller-${index + 1}`,
      clusterId,
      instanceId: spec.instanceId,
      repositoryId: spec.repositoryId,
      runtimeEpoch: spec.runtimeEpoch,
      generation: spec.generation,
      resources: { ...spec.resourceProfile.request },
      status: "reserved",
    }));
    this.#snapshot = {
      clusterId,
      capacityEpoch: 0,
      observedAt: 0,
      complete: true,
      capacity: null,
      representedReservationIds: [],
      reservations: this.#reservations,
    };
  }

  async currentReservations(clusterId) {
    assert.equal(clusterId, this.#clusterId);
    return structuredClone(this.#snapshot);
  }

  async recordCapacitySnapshot(input) {
    assert.equal(input.clusterId, this.#clusterId);
    assert.equal(input.complete, true);
    assert.ok(input.nodeResourceVersion && input.podResourceVersion);
    assert.ok(Array.isArray(input.representedReservationIds));
    const represented = new Set(input.representedReservationIds);
    const epoch = this.#snapshot.capacityEpoch + 1;
    this.#reservations = this.#reservations.map((reservation) => {
      if (reservation.status === "released") return reservation;
      return {
        ...reservation,
        status: represented.has(reservation.reservationId) ? "allocated" : "reserved",
      };
    });
    this.#snapshot = {
      clusterId: this.#clusterId,
      capacityEpoch: epoch,
      observedAt: input.observedAt,
      complete: true,
      capacity: structuredClone(input.capacity),
      representedReservationIds: [...represented].sort(),
      reservations: structuredClone(this.#reservations),
    };
    return epoch;
  }

  setStatus(instanceId, status) {
    this.#reservations = this.#reservations.map((reservation) =>
      reservation.instanceId === instanceId ? { ...reservation, status } : reservation,
    );
    this.#snapshot = { ...this.#snapshot, reservations: structuredClone(this.#reservations) };
  }
}

function makeRuntime(config, api, reservations) {
  const maximumResources = {
    cpuMilli: config.cluster.maximumResources.cpuMilli,
    memoryMiB: config.cluster.maximumResources.memoryMiB,
    ephemeralStorageMiB: config.cluster.maximumResources.ephemeralStorageMiB,
  };
  const renderer = createKubernetesResourceRenderer({
    namespacePrefix: config.cluster.namespacePrefix,
    clusterId: config.cluster.id,
    ingressNamespace: config.cluster.ingressNamespace,
    instanceAccessNamespace: config.cluster.instanceAccessNamespace,
    instanceAccessService: "instance-access",
    controlNamespace: "praetorium-system",
    controlService: "provisioner",
    maximumResources,
  });
  return new KubernetesRuntimeProvider({
    api,
    namespacePrefix: config.cluster.namespacePrefix,
    clusterId: config.cluster.id,
    renderer,
    reservations,
    maxCapacityAgeMs: 30_000,
    maxActivationEvidenceAgeMs: 30_000,
  });
}

function metadataOf(value) {
  return isRecord(value?.metadata) ? value.metadata : {};
}

function namespaceOf(value) {
  const metadata = metadataOf(value);
  return typeof metadata.name === "string" ? metadata.name : "";
}

function objectUid(value) {
  const uid = metadataOf(value).uid;
  assert.ok(
    typeof uid === "string" && uid.length > 0,
    "Kubernetes object must expose its live UID",
  );
  return uid;
}

function objectResourceVersion(value) {
  const resourceVersion = metadataOf(value).resourceVersion;
  assert.ok(
    typeof resourceVersion === "string" && resourceVersion.length > 0,
    "Kubernetes object must expose its live resourceVersion",
  );
  return resourceVersion;
}

async function getNamespaceOptional(api, name) {
  try {
    return await api.getNamespace(name);
  } catch (error) {
    if (error instanceof KubernetesApiError && error.statusCode === 404) return undefined;
    throw error;
  }
}

async function listAll(api, kind, namespace) {
  const items = [];
  let cursor;
  const cursors = new Set();
  do {
    const page = await api.list(kind, namespace, "", cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor !== undefined) {
      assert.ok(
        !cursors.has(cursor),
        `Kubernetes ${kind} pagination repeated a continuation token`,
      );
      cursors.add(cursor);
    }
    assert.ok(items.length <= 10_000, `Kubernetes ${kind} census exceeded the runner bound`);
  } while (cursor !== undefined);
  return items;
}

function validRunNamespace(name, prefix) {
  return name.startsWith(`${prefix}-`) && name.length <= 63 && DNS_LABEL.test(name);
}

function abortSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}

function effectGuard(run, inventory, config) {
  let count = 0;
  const guard = () => {
    assert.equal(
      inventory.resources[CATEGORY].state,
      "available",
      "owned Kubernetes resource is no longer available",
    );
    assert.equal(
      inventory.environment.production,
      false,
      "refusing effects against a production inventory",
    );
    assert.equal(
      inventory.environment.disposable,
      true,
      "refusing effects against a nondisposable inventory",
    );
    assert.ok(
      Date.parse(inventory.environment.expiresAt) > Date.now(),
      "owned T14 inventory expired during execution",
    );
    assert.ok(run.length === 20 && /^[a-f0-9]+$/u.test(run), "runner ownership token is invalid");
    assert.ok(config.cluster.name.startsWith("praetorium-t14-"), "runner cluster identity changed");
    count += 1;
  };
  Object.defineProperty(guard, "count", { get: () => count });
  return guard;
}

function guardKubernetesApi(api, guard) {
  const mutations = new Set([
    "apply",
    "create",
    "applyConditional",
    "delete",
    "deleteConditional",
    "createNamespace",
    "applyNamespaceConditional",
    "deleteNamespaceConditional",
  ]);
  return new Proxy(api, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (mutations.has(property)) {
        return (...args) => {
          guard();
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}

function responseBody(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > 16 * 1024) {
        reject(new Error("T14 ingress response exceeded the bounded body size"));
        response.destroy();
      } else {
        chunks.push(Buffer.from(chunk));
      }
    });
    response.on("error", reject);
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function requestIngress({ address, port, hostname, ca, requestMs, pathname }) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: address,
        port,
        method: "GET",
        path: pathname,
        headers: { host: hostname },
        servername: hostname,
        ca,
        rejectUnauthorized: true,
        timeout: requestMs,
      },
      async (response) => {
        try {
          resolve({ status: response.statusCode ?? 0, body: await responseBody(response) });
        } catch (error) {
          reject(error);
        }
      },
    );
    request.on("timeout", () => request.destroy(new Error("owned ingress request timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function preflightIngress(config, ca, hostname) {
  const response = await requestIngress({
    address: config.network.ingressAddress,
    port: config.network.ingressPort,
    hostname,
    ca,
    requestMs: config.timeouts.requestMs,
    pathname: "/__t14_preflight",
  });
  assert.ok(
    response.status >= 200 && response.status < 500,
    "owned ingress TLS endpoint is not accepting requests",
  );
}

async function preflightPublicEgress(config) {
  const response = await fetch(config.network.publicEgressUrl, {
    signal: abortSignal(config.timeouts.requestMs),
    redirect: "error",
  });
  assert.equal(
    response.status,
    200,
    "configured public egress marker endpoint must return HTTP 200",
  );
  const reader = response.body?.getReader();
  assert.ok(reader, "configured public egress marker endpoint returned no body");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    assert.ok(
      size <= 16 * 1024,
      "configured public egress marker response exceeded the bounded body size",
    );
    chunks.push(Buffer.from(value));
  }
  assert.equal(
    Buffer.concat(chunks).toString("utf8").trim(),
    config.network.publicEgressMarker,
    "configured public egress marker endpoint returned unexpected content",
  );
}

async function getLiveProvisionerHealthTarget(controllerApi) {
  const provisionerPods = await controllerApi.list(
    "Pod",
    "praetorium-system",
    `${APP_LABEL}=provisioner`,
  );
  const liveProvisionerPod = provisionerPods.items.find(
    (pod) =>
      pod?.status?.phase === "Running" &&
      typeof pod?.status?.podIP === "string" &&
      isIP(pod.status.podIP) !== 0 &&
      pod?.status?.containerStatuses?.some(
        (container) => container?.name === "provisioner" && container?.state?.running,
      ),
  );
  assert.ok(
    liveProvisionerPod,
    "target Provisioner has no live process for the private health-path probe",
  );
  const controlHost =
    isIP(liveProvisionerPod.status.podIP) === 6
      ? `[${liveProvisionerPod.status.podIP}]`
      : liveProvisionerPod.status.podIP;
  return {
    uid: objectUid(liveProvisionerPod),
    url: `http://${controlHost}:8080/healthz`,
  };
}

async function preflightCluster(config, controllerApi, provider) {
  const kubeSystem = await controllerApi.getNamespace("kube-system");
  assert.equal(
    namespaceOf(kubeSystem),
    "kube-system",
    "explicit Kubernetes API did not return the expected system namespace",
  );
  const systemNamespace = await controllerApi.getNamespace(config.cluster.instanceAccessNamespace);
  assert.equal(namespaceOf(systemNamespace), "praetorium-system");
  assert.equal(
    metadataOf(systemNamespace).labels?.["app.kubernetes.io/part-of"],
    "praetorium",
    "target system namespace is not labeled as part of the deployed platform",
  );
  for (const key of ["enforce", "audit", "warn"]) {
    assert.equal(
      metadataOf(systemNamespace).labels?.[`pod-security.kubernetes.io/${key}`],
      "restricted",
      `target system namespace must retain Pod Security Standard ${key}=restricted`,
    );
  }

  const observabilityNamespace = await controllerApi.getNamespace(CONTROL_PROBE_NAMESPACE);
  assert.equal(namespaceOf(observabilityNamespace), CONTROL_PROBE_NAMESPACE);
  assert.equal(
    metadataOf(observabilityNamespace).labels?.["app.kubernetes.io/part-of"],
    "praetorium",
    "control-probe namespace is not labeled as part of the deployed platform",
  );
  for (const key of ["enforce", "audit", "warn"]) {
    assert.equal(
      metadataOf(observabilityNamespace).labels?.[`pod-security.kubernetes.io/${key}`],
      "restricted",
      `control-probe namespace must retain Pod Security Standard ${key}=restricted`,
    );
  }

  const prometheusService = await controllerApi.get({
    kind: "Service",
    namespace: CONTROL_PROBE_NAMESPACE,
    name: "praetorium-prometheus",
  });
  assert.deepEqual(
    prometheusService?.spec?.selector,
    { [APP_LABEL]: "prometheus" },
    "actual Prometheus Service selector changed",
  );
  const prometheusDeployment = await controllerApi.get({
    kind: "Deployment",
    namespace: CONTROL_PROBE_NAMESPACE,
    name: "praetorium-prometheus",
  });
  assert.equal(metadataOf(prometheusDeployment).labels?.[APP_LABEL], "prometheus");
  assert.deepEqual(
    prometheusDeployment?.spec?.selector?.matchLabels,
    { [APP_LABEL]: "prometheus" },
    "actual Prometheus Deployment selector changed",
  );
  assert.equal(
    prometheusDeployment?.spec?.template?.metadata?.labels?.[APP_LABEL],
    "prometheus",
    "actual Prometheus Pod template selector changed",
  );

  const provisionerConfig = await controllerApi.get({
    kind: "ConfigMap",
    namespace: "praetorium-system",
    name: "praetorium-provisioner-config",
  });
  const provisionerValues = provisionerConfig?.data ?? {};
  for (const [key, expected] of Object.entries({
    PROVISIONER_CLUSTER_ID: config.cluster.id,
    PROVISIONER_NAMESPACE_PREFIX: config.cluster.namespacePrefix,
    PROVISIONER_INGRESS_NAMESPACE: config.cluster.ingressNamespace,
    PROVISIONER_CONTROL_NAMESPACE: "praetorium-system",
    PROVISIONER_CONTROL_SERVICE: "provisioner",
    PROVISIONER_INSTANCE_ACCESS_NAMESPACE: "praetorium-system",
    PROVISIONER_INSTANCE_ACCESS_SERVICE: "instance-access",
    PROVISIONER_HEALTH_PORT: "8080",
    PROVISIONER_MAX_CPU_MILLI: String(config.cluster.maximumResources.cpuMilli),
    PROVISIONER_MAX_MEMORY_MIB: String(config.cluster.maximumResources.memoryMiB),
    PROVISIONER_MAX_EPHEMERAL_STORAGE_MIB: String(
      config.cluster.maximumResources.ephemeralStorageMiB,
    ),
  })) {
    assert.equal(
      provisionerValues[key],
      expected,
      `private T14 input does not match target provisioner setting ${key}`,
    );
  }

  const instanceAccessConfig = await controllerApi.get({
    kind: "ConfigMap",
    namespace: "praetorium-system",
    name: "praetorium-instance-access-config",
  });
  assert.equal(
    instanceAccessConfig?.data?.INSTANCE_ACCESS_INSTANCE_HOSTNAME_SUFFIX,
    config.network.hostnameSuffix,
    "private T14 input does not match the target instance hostname suffix",
  );

  for (const service of [
    {
      name: "instance-access",
      deployment: "praetorium-instance-access",
      label: "instance-access",
      serviceAccount: "praetorium-instance-access",
    },
    {
      name: "provisioner",
      deployment: "praetorium-provisioner",
      label: "provisioner",
      serviceAccount: "praetorium-provisioner",
    },
  ]) {
    const currentService = await controllerApi.get({
      kind: "Service",
      namespace: "praetorium-system",
      name: service.name,
    });
    assert.deepEqual(
      currentService?.spec?.selector,
      { [APP_LABEL]: service.label },
      `target ${service.name} Service selector changed`,
    );
    assert.equal(
      metadataOf(currentService).labels?.[APP_LABEL],
      service.label,
      `target ${service.name} Service identity changed`,
    );
    assert.equal(
      metadataOf(currentService).labels?.["app.kubernetes.io/part-of"],
      "praetorium",
      `target ${service.name} Service platform identity changed`,
    );
    const deployment = await controllerApi.get({
      kind: "Deployment",
      namespace: "praetorium-system",
      name: service.deployment,
    });
    assert.equal(
      metadataOf(deployment).name,
      service.deployment,
      `target ${service.deployment} Deployment identity changed`,
    );
    assert.equal(
      metadataOf(deployment).labels?.[APP_LABEL],
      service.label,
      `target ${service.deployment} ownership selector changed`,
    );
    assert.deepEqual(
      deployment?.spec?.selector?.matchLabels,
      { [APP_LABEL]: service.label },
      `target ${service.deployment} Pod selector changed`,
    );
    assert.equal(
      deployment?.spec?.template?.metadata?.labels?.[APP_LABEL],
      service.label,
      `target ${service.deployment} Pod template label changed`,
    );
    assert.equal(
      deployment?.spec?.template?.spec?.serviceAccountName,
      service.serviceAccount,
      `target ${service.deployment} ServiceAccount identity changed`,
    );
    const serviceAccount = await controllerApi.get({
      kind: "ServiceAccount",
      namespace: "praetorium-system",
      name: service.serviceAccount,
    });
    assert.equal(
      metadataOf(serviceAccount).labels?.[APP_LABEL],
      service.label,
      `target ${service.serviceAccount} ServiceAccount ownership changed`,
    );
    assert.equal(
      metadataOf(serviceAccount).labels?.["app.kubernetes.io/part-of"],
      "praetorium",
      `target ${service.serviceAccount} ServiceAccount platform identity changed`,
    );
  }

  const ingressNamespace = await controllerApi.getNamespace(config.cluster.ingressNamespace);
  assert.equal(
    namespaceOf(ingressNamespace),
    config.cluster.ingressNamespace,
    "configured ingress namespace is absent",
  );
  const ingressPods = await controllerApi.list(
    "Pod",
    config.cluster.ingressNamespace,
    `${APP_LABEL}=traefik`,
  );
  assert.ok(
    ingressPods.items.some(
      (pod) =>
        pod?.status?.phase === "Running" &&
        pod?.status?.conditions?.some(
          (condition) => condition?.type === "Ready" && condition?.status === "True",
        ),
    ),
    "configured Traefik namespace has no Ready ingress Pod with the NetworkPolicy source label",
  );
  const controlHealthTarget = await getLiveProvisionerHealthTarget(controllerApi);
  const capacity = await provider.getCapacitySnapshot(undefined, config.cluster.resourceProfile.id);
  assert.equal(capacity.authoritative, true, "provider did not return authoritative live capacity");
  assert.ok(
    capacity.nodeResourceVersion.length > 0 && capacity.podResourceVersion.length > 0,
    "provider capacity must include live Node and Pod resourceVersions",
  );
  assert.ok(capacity.nodes.length > 0, "owned disposable cluster has no schedulable Node capacity");
  return {
    capacity,
    controlHealthTarget,
  };
}

async function selfReview(transport, apiVersion, review, signal) {
  const response = await transport.request({
    method: "POST",
    path: `/apis/${apiVersion}/selfsubjectreviews`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(review),
    signal,
  });
  assert.ok(
    response.statusCode === 200 || response.statusCode === 201,
    `Kubernetes self-review API failed with HTTP ${response.statusCode}`,
  );
  return response.body;
}

async function verifyProvisionerIdentity(transport, runtimeNamespaceName) {
  const self = await selfReview(
    transport,
    "authentication.k8s.io/v1",
    { apiVersion: "authentication.k8s.io/v1", kind: "SelfSubjectReview", spec: {} },
    abortSignal(10_000),
  );
  assert.equal(
    self?.status?.userInfo?.username,
    "system:serviceaccount:praetorium-system:praetorium-provisioner",
    "provider Kubernetes API credential is not the exact deployed Provisioner ServiceAccount",
  );
  for (const attributes of [
    {
      verb: "create",
      group: "",
      version: "v1",
      resource: "pods",
      namespace: runtimeNamespaceName,
    },
    { verb: "delete", group: "", version: "v1", resource: "namespaces" },
  ]) {
    const authorization = await selfReview(
      transport,
      "authorization.k8s.io/v1",
      {
        apiVersion: "authorization.k8s.io/v1",
        kind: "SelfSubjectAccessReview",
        spec: { resourceAttributes: attributes },
      },
      abortSignal(10_000),
    );
    assert.equal(
      authorization?.status?.allowed,
      false,
      `Provisioner ServiceAccount unexpectedly has ${attributes.verb} permission for ${attributes.resource}`,
    );
    assert.equal(
      authorization?.status?.evaluationError,
      undefined,
      "Kubernetes could not complete a Provisioner authorization review",
    );
  }
}

function podMetadata(name, namespace, run, inventoryId, labels = {}) {
  return {
    name,
    namespace,
    labels: { [RUN_LABEL]: run, [INVENTORY_LABEL]: inventoryId, ...labels },
  };
}

function probeContainer(config, script, env = []) {
  const request = {
    cpu: `${config.cluster.resourceProfile.cpuMilli}m`,
    memory: `${config.cluster.resourceProfile.memoryMiB}Mi`,
    "ephemeral-storage": `${config.cluster.resourceProfile.ephemeralStorageMiB}Mi`,
  };
  const limits = {
    cpu: `${config.cluster.maximumResources.cpuMilli}m`,
    memory: `${config.cluster.maximumResources.memoryMiB}Mi`,
    "ephemeral-storage": `${config.cluster.maximumResources.ephemeralStorageMiB}Mi`,
  };
  return {
    name: "t14-probe",
    image: config.probe.imageRef,
    imagePullPolicy: "IfNotPresent",
    command: ["/bin/sh", "-ec", script],
    env: [
      { name: "T14_PUBLIC_URL", value: config.network.publicEgressUrl },
      { name: "T14_PUBLIC_HOST", value: new URL(config.network.publicEgressUrl).hostname },
      { name: "T14_PUBLIC_MARKER", value: config.network.publicEgressMarker },
      ...env,
    ],
    resources: { requests: request, limits },
    securityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 65_532,
      runAsGroup: 65_532,
      seccompProfile: { type: "RuntimeDefault" },
      capabilities: { drop: ["ALL"] },
    },
  };
}

function podResource(
  name,
  namespace,
  run,
  inventoryId,
  config,
  script,
  labels,
  env = [],
  nodeSelector = undefined,
) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: podMetadata(name, namespace, run, inventoryId, labels),
    spec: {
      restartPolicy: "Never",
      serviceAccountName: "default",
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65_532,
        runAsGroup: 65_532,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [probeContainer(config, script, env)],
      ...(nodeSelector === undefined ? {} : { nodeSelector }),
    },
  };
}

function tenantFixtureLabels(spec) {
  return {
    [PLATFORM_LABEL_KEY]: PLATFORM_LABEL_VALUE,
    [MANAGED_BY_LABEL_KEY]: MANAGED_BY_LABEL_VALUE,
    [INSTANCE_LABEL]: spec.instanceId,
    [REPOSITORY_LABEL_KEY]: String(spec.repositoryId),
    [OWNERSHIP_LABEL_KEY]: OWNERSHIP_VERSION,
    [CLUSTER_LABEL_KEY]: spec.clusterId,
    [APP_LABEL]: "scriptorium",
  };
}

function podStatus(value) {
  const status = isRecord(value?.status) ? value.status : {};
  const container = Array.isArray(status.containerStatuses)
    ? status.containerStatuses[0]
    : undefined;
  const terminated = container?.state?.terminated;
  return {
    phase: status.phase,
    exitCode: terminated?.exitCode,
    imageId: container?.imageID,
    reason: terminated?.reason,
  };
}

function digestFromImageId(imageId) {
  if (typeof imageId !== "string") return null;
  return /sha256:[0-9a-f]{64}$/u.exec(imageId)?.[0] ?? null;
}

async function waitForPodTerminal(api, namespace, name, timeoutMs, requestMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pod = await api.get({ kind: "Pod", namespace, name }, abortSignal(requestMs));
    const status = podStatus(pod);
    if (status.phase === "Succeeded" || status.phase === "Failed") return { pod, status };
    await delay(1_000);
  }
  throw new Error(
    `T14 probe Pod ${namespace}/${name} did not terminate within its bounded deadline`,
  );
}

async function waitForPodRunning(api, entry, config) {
  const deadline = Date.now() + config.timeouts.readinessMs;
  while (Date.now() < deadline) {
    const pod = await api.get(
      { kind: "Pod", namespace: entry.namespace, name: entry.name },
      abortSignal(config.timeouts.requestMs),
    );
    assert.equal(metadataOf(pod).uid, entry.uid, "test writer Pod was replaced while scheduling");
    const status = podStatus(pod);
    if (status.phase === "Running") {
      assert.equal(
        digestFromImageId(status.imageId),
        config.probe.platformManifestDigest,
        "unbound writer Pod imageID did not match the configured immutable platform digest",
      );
      return pod;
    }
    assert.notEqual(
      status.phase,
      "Failed",
      `unbound writer Pod failed (${status.reason ?? "unknown reason"})`,
    );
    await delay(1_000);
  }
  throw new Error(`unbound writer Pod ${entry.namespace}/${entry.name} did not become Running`);
}

async function waitForPodAbsent(api, entry, run, inventoryId, requestMs) {
  const timeoutMs = Math.min(60_000, Math.max(10_000, requestMs * 5));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const current = await api.get(
        { kind: "Pod", namespace: entry.namespace, name: entry.name },
        abortSignal(requestMs),
      );
      validateNamespaceAndPodOwnership(current, run, inventoryId, {});
      assert.equal(objectUid(current), entry.uid, "refusing to wait on a replacement probe Pod");
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404) return;
      throw error;
    }
    await delay(500);
  }
  throw new Error(`run-owned probe Pod ${entry.namespace}/${entry.name} was not deleted in time`);
}

async function createAndRunPod({
  api,
  config,
  namespace,
  name,
  run,
  inventoryId,
  labels,
  script,
  env,
  timeoutMs,
  trackedPods,
  nodeSelector,
}) {
  const resource = podResource(
    name,
    namespace,
    run,
    inventoryId,
    config,
    script,
    labels,
    env,
    nodeSelector,
  );
  const created = await api.create(resource, abortSignal(config.timeouts.requestMs));
  const entry = {
    namespace,
    name,
    uid: objectUid(created),
    resourceVersion: objectResourceVersion(created),
  };
  trackedPods.set(`${namespace}/${name}`, entry);
  validateNamespaceAndPodOwnership(created, run, inventoryId, labels);
  const { pod, status } = await waitForPodTerminal(
    api,
    namespace,
    name,
    timeoutMs,
    config.timeouts.requestMs,
  );
  validateNamespaceAndPodOwnership(pod, run, inventoryId, labels);
  assert.equal(metadataOf(pod).uid, entry.uid, "probe Pod was replaced during execution");
  assert.equal(
    status.phase,
    "Succeeded",
    `probe Pod failed (${status.reason ?? `exit ${status.exitCode}`})`,
  );
  assert.equal(status.exitCode, 0, "probe Pod did not report successful actual network requests");
  assert.equal(
    digestFromImageId(status.imageId),
    config.probe.platformManifestDigest,
    "probe Pod imageID did not match the configured immutable platform digest",
  );
  entry.resourceVersion = objectResourceVersion(pod);
  return { pod, status, entry };
}

function validateNamespaceAndPodOwnership(pod, run, inventoryId, expectedLabels) {
  const metadata = metadataOf(pod);
  assert.equal(metadata.labels?.[RUN_LABEL], run, "probe Pod runner ownership label changed");
  assert.equal(
    metadata.labels?.[INVENTORY_LABEL],
    inventoryId,
    "probe Pod inventory ownership label changed",
  );
  for (const [key, value] of Object.entries(expectedLabels)) {
    assert.equal(metadata.labels?.[key], value, `probe Pod label ${key} changed`);
  }
}

async function cleanupPod(api, trackedPods, key, run, inventoryId, requestMs) {
  const entry = trackedPods.get(key);
  if (!entry) return;
  const reference = { kind: "Pod", namespace: entry.namespace, name: entry.name };
  let deleted = false;
  for (let attempt = 0; attempt < 5 && !deleted; attempt += 1) {
    let current;
    try {
      current = await api.get(reference, abortSignal(requestMs));
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404) {
        deleted = true;
        break;
      }
      throw error;
    }
    validateNamespaceAndPodOwnership(current, run, inventoryId, {});
    assert.equal(objectUid(current), entry.uid, "refusing to delete a replacement probe Pod");
    try {
      await api.deleteConditional(
        reference,
        { uid: entry.uid, resourceVersion: objectResourceVersion(current) },
        abortSignal(requestMs),
      );
      deleted = true;
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404) {
        deleted = true;
        break;
      }
      if (error instanceof KubernetesApiError && error.statusCode === 409) continue;
      throw error;
    }
  }
  assert.equal(deleted, true, `could not conditionally delete run-owned Pod ${key}`);
  await waitForPodAbsent(api, entry, run, inventoryId, requestMs);
  trackedPods.delete(key);
}

async function createRuntimeAndWait(runtime, spec, guard, config) {
  const result = await runtime.ensureRunning(spec, abortSignal(config.timeouts.readinessMs), guard);
  assert.equal(
    result.observation.writerCensus.complete,
    true,
    "provider admission returned an incomplete writer census",
  );
  const deadline = Date.now() + config.timeouts.readinessMs;
  while (Date.now() < deadline) {
    const observation = await runtime.inspect(spec, abortSignal(config.timeouts.requestMs));
    if (observation.state === "running" && observation.writerState === "running") {
      assert.equal(observation.writerCensus.complete, true, "provider writer census is incomplete");
      assert.equal(
        observation.writerCensus.queriedPodCount,
        1,
        "provider must observe exactly one writer Pod",
      );
      assert.equal(
        observation.observedImageDigest,
        spec.release.platformManifestDigest,
        "provider actual Pod imageID does not match the selected platform manifest",
      );
      return observation;
    }
    await delay(1_000);
  }
  throw new Error(
    `provider did not observe ${spec.instanceId} ready before the configured deadline`,
  );
}

async function stopRuntimeAndWait(runtime, api, spec, guard, config) {
  const result = await runtime.ensureStopped(spec, abortSignal(config.timeouts.readinessMs), guard);
  assert.equal(
    result.observation.writerCensus.complete,
    true,
    "provider stop returned an incomplete writer census",
  );
  const deadline = Date.now() + config.timeouts.readinessMs;
  while (Date.now() < deadline) {
    const observation = await runtime.inspect(spec, abortSignal(config.timeouts.requestMs));
    if (observation.writerCensus.queriedPodCount === 0 && observation.state === "stopped") {
      try {
        await api.get({
          kind: "IngressRoute",
          namespace: runtimeNamespace(config, spec.instanceId),
          name: runtimeService(spec.instanceId),
        });
      } catch (error) {
        if (error instanceof KubernetesApiError && error.statusCode === 404) return observation;
        throw error;
      }
      assert.fail("provider stop left the runtime IngressRoute active");
    }
    await delay(1_000);
  }
  throw new Error(
    `provider did not observe ${spec.instanceId} stopped before the configured deadline`,
  );
}

function appAndAuthScript(serviceHost, port) {
  return [
    "set -eu",
    `curl --disable --fail --silent --show-error --max-time 10 "http://${serviceHost}:${port}${APP_READY_PATH}" | grep -Fqx '${PROBE_READY_MARKER}'`,
    `curl --disable --fail --silent --show-error --max-time 10 -H 'Authorization: Bearer ${PROBE_AUTH_VALUE}' "http://${serviceHost}:${port}${APP_AUTH_PATH}" | grep -Fqx '${PROBE_AUTH_MARKER}'`,
  ].join("\n");
}

function controlApiReachableScript() {
  return [
    "set -eu",
    'curl --disable --fail --silent --show-error --max-time 8 "$T14_CONTROL_HEALTH_URL" | grep -Fqx \'{"status":"ok"}\'',
    "getent hosts kubernetes.default.svc.cluster.local >/dev/null",
    "status=$(curl --disable --insecure --silent --show-error --max-time 8 --output /dev/null --write-out '%{http_code}' https://kubernetes.default.svc.cluster.local/version)",
    "case \"$status\" in 401|403) ;; *) echo 'Kubernetes control API did not return unauthenticated 401/403' >&2; exit 1 ;; esac",
  ].join("\n");
}

async function runControlApiProbe({
  api,
  config,
  controlHealthTarget,
  run,
  inventoryId,
  trackedPods,
}) {
  const name = `control-api-${randomBytes(5).toString("hex")}`;
  const key = `${CONTROL_PROBE_NAMESPACE}/${name}`;
  try {
    await createAndRunPod({
      api,
      config,
      namespace: CONTROL_PROBE_NAMESPACE,
      name,
      run,
      inventoryId,
      labels: { [APP_LABEL]: "prometheus" },
      script: controlApiReachableScript(),
      env: [{ name: "T14_CONTROL_HEALTH_URL", value: controlHealthTarget.url }],
      timeoutMs: config.timeouts.readinessMs,
      trackedPods,
    });
  } finally {
    await cleanupPod(api, trackedPods, key, run, inventoryId, config.timeouts.requestMs);
  }
}

function tenantNetworkScript(peerHost, peerPort, peerMarker, config) {
  return [
    "set -eu",
    `getent hosts "${peerHost}" >/dev/null`,
    `status=$(curl --disable --silent --show-error --connect-timeout 3 --max-time ${Math.ceil(config.timeouts.networkProbeMs / 1000)} --output /dev/null --write-out '%{http_code}' "http://${peerHost}:${peerPort}${APP_READY_PATH}" || true)`,
    "if [ \"$status\" != 000 ]; then echo 'cross-instance packet unexpectedly reached the peer' >&2; exit 1; fi",
    "getent hosts kubernetes.default.svc.cluster.local >/dev/null",
    `status=$(curl --disable --insecure --silent --show-error --connect-timeout 3 --max-time ${Math.ceil(config.timeouts.networkProbeMs / 1000)} --output /dev/null --write-out '%{http_code}' https://kubernetes.default.svc.cluster.local/version || true)`,
    "if [ \"$status\" != 000 ]; then echo 'tenant packet unexpectedly reached the Kubernetes control API' >&2; exit 1; fi",
    `status=$(curl --disable --silent --show-error --connect-timeout 3 --max-time ${Math.ceil(config.timeouts.networkProbeMs / 1000)} --output /dev/null --write-out '%{http_code}' "$T14_CONTROL_HEALTH_URL" || true)`,
    "if [ \"$status\" != 000 ]; then echo 'tenant packet unexpectedly reached the private Provisioner control endpoint' >&2; exit 1; fi",
    `status=$(curl --disable --silent --show-error --connect-timeout 2 --max-time ${Math.ceil(config.timeouts.networkProbeMs / 1000)} --output /dev/null --write-out '%{http_code}' http://169.254.169.254/ || true)`,
    "if [ \"$status\" != 000 ]; then echo 'tenant packet unexpectedly reached link-local metadata' >&2; exit 1; fi",
    'getent hosts "$T14_PUBLIC_HOST" >/dev/null',
    `curl --disable --fail --silent --show-error --max-time ${Math.ceil(config.timeouts.networkProbeMs / 1000)} "$T14_PUBLIC_URL" | grep -Fqx "$T14_PUBLIC_MARKER"`,
  ].join("\n");
}

async function runPositiveAppProbes({
  api,
  config,
  spec,
  helperNamespace,
  run,
  inventoryId,
  trackedPods,
}) {
  const name = `app-auth-${randomBytes(5).toString("hex")}`;
  const host = `${runtimeService(spec.instanceId)}.${runtimeNamespace(config, spec.instanceId)}.svc.cluster.local`;
  const labels = { [APP_LABEL]: "provisioner" };
  const { entry } = await createAndRunPod({
    api,
    config,
    namespace: helperNamespace,
    name,
    run,
    inventoryId,
    labels,
    script: appAndAuthScript(host, config.probe.httpPort),
    env: [],
    timeoutMs: config.timeouts.readinessMs,
    trackedPods,
  });
  const observedAt = Date.now();
  return {
    applicationProbe: {
      id: `t14-application-${entry.uid}`,
      observedAt,
      ready: true,
    },
    authProbe: {
      id: `t14-test-auth-${entry.uid}`,
      observedAt,
      ready: true,
    },
    podKey: `${helperNamespace}/${name}`,
  };
}

async function verifyRuntimePeer({
  runtime,
  api,
  config,
  spec,
  helperNamespace,
  run,
  inventoryId,
  trackedPods,
}) {
  const { podKey } = await runPositiveAppProbes({
    api,
    config,
    spec,
    helperNamespace,
    run,
    inventoryId,
    trackedPods,
  });
  try {
    const observation = await runtime.inspect(spec, abortSignal(config.timeouts.requestMs));
    assert.equal(observation.state, "running", "cross-instance peer is not running");
    assert.equal(observation.writerState, "running", "cross-instance peer writer is not ready");
    assert.equal(observation.writerCensus.complete, true, "peer writer census is incomplete");
    assert.equal(observation.writerCensus.queriedPodCount, 1, "peer must have exactly one writer");
    assert.equal(
      observation.observedImageDigest,
      spec.release.platformManifestDigest,
      "cross-instance peer imageID does not match the configured immutable platform digest",
    );
    const writerUid = observation.writerCensus.pods[0]?.uid;
    assert.ok(typeof writerUid === "string" && writerUid.length > 0);
    return writerUid;
  } finally {
    await cleanupPod(api, trackedPods, podKey, run, inventoryId, config.timeouts.requestMs);
  }
}

async function activateAndVerifyIngress({
  runtime,
  api,
  config,
  spec,
  helperNamespace,
  run,
  inventoryId,
  trackedPods,
  ca,
  guard,
}) {
  const { podKey, ...probes } = await runPositiveAppProbes({
    api,
    config,
    spec,
    helperNamespace,
    run,
    inventoryId,
    trackedPods,
  });
  try {
    const observation = await runtime.inspect(spec, abortSignal(config.timeouts.requestMs));
    assert.equal(
      observation.observedImageDigest,
      spec.release.platformManifestDigest,
      "activation probe is not paired with the actual selected imageID",
    );
    const activated = await runtime.activateEndpoint(
      spec,
      { identity: spec, actualImageDigest: observation.observedImageDigest, ...probes },
      abortSignal(config.timeouts.requestMs),
      guard,
    );
    assert.equal(
      activated.endpoint,
      `https://${spec.hostname}`,
      "provider activated an unexpected host",
    );
    const response = await requestIngress({
      address: config.network.ingressAddress,
      port: config.network.ingressPort,
      hostname: spec.hostname,
      ca,
      requestMs: config.timeouts.requestMs,
      pathname: APP_INGRESS_PATH,
    });
    assert.equal(
      response.status,
      200,
      "owned TLS ingress did not route to the ready probe workload",
    );
    assert.equal(
      response.body.trim(),
      PROBE_INGRESS_MARKER,
      "owned ingress returned the wrong probe workload marker",
    );
  } finally {
    await cleanupPod(api, trackedPods, podKey, run, inventoryId, config.timeouts.requestMs);
  }
}

async function runTenantNetworkProbe({
  api,
  config,
  source,
  target,
  controlHealthUrl,
  run,
  inventoryId,
  trackedPods,
}) {
  const sourceNamespace = runtimeNamespace(config, source.instanceId);
  const sourceResourceName = `net-${randomBytes(5).toString("hex")}`;
  const peerHost = `${runtimeService(target.instanceId)}.${runtimeNamespace(config, target.instanceId)}.svc.cluster.local`;
  const labels = tenantFixtureLabels(source);
  const result = await createAndRunPod({
    api,
    config,
    namespace: sourceNamespace,
    name: sourceResourceName,
    run,
    inventoryId,
    labels,
    script: tenantNetworkScript(peerHost, config.probe.httpPort, PROBE_READY_MARKER, config),
    env: [{ name: "T14_CONTROL_HEALTH_URL", value: controlHealthUrl }],
    timeoutMs: config.timeouts.readinessMs,
    trackedPods,
  });
  assert.equal(result.status.phase, "Succeeded");
}

async function createUnknownCapacityPod({
  api,
  observerApi,
  config,
  helperNamespace,
  run,
  inventoryId,
  trackedPods,
}) {
  const name = `unsched-${randomBytes(5).toString("hex")}`;
  const nodes = await listAll(observerApi, "Node", "");
  const nodeSelectorKey = `t14-${run.slice(0, 12)}.praetorium.invalid/absent`;
  assert.ok(
    nodes.every((node) => !Object.hasOwn(node?.metadata?.labels ?? {}, nodeSelectorKey)),
    "generated capacity fence unexpectedly exists on a live Node",
  );
  const resource = podResource(
    name,
    helperNamespace,
    run,
    inventoryId,
    config,
    "sleep 600",
    { [PROBE_APP_LABEL]: "unknown-capacity" },
    [],
    { [nodeSelectorKey]: "absent" },
  );
  const created = await api.create(resource, abortSignal(config.timeouts.requestMs));
  validateNamespaceAndPodOwnership(created, run, inventoryId, {
    [PROBE_APP_LABEL]: "unknown-capacity",
  });
  const entry = {
    namespace: helperNamespace,
    name,
    uid: objectUid(created),
    resourceVersion: objectResourceVersion(created),
  };
  trackedPods.set(`${helperNamespace}/${name}`, entry);
  return { entry };
}

async function createUnboundWriter({ api, config, spec, run, inventoryId, trackedPods }) {
  const namespace = runtimeNamespace(config, spec.instanceId);
  const name = `unbound-${randomBytes(5).toString("hex")}`;
  const labels = tenantFixtureLabels(spec);
  const pod = podResource(name, namespace, run, inventoryId, config, "sleep 600", labels);
  delete pod.spec.nodeSelector;
  const created = await api.create(pod, abortSignal(config.timeouts.requestMs));
  validateNamespaceAndPodOwnership(created, run, inventoryId, labels);
  const entry = {
    namespace,
    name,
    uid: objectUid(created),
    resourceVersion: objectResourceVersion(created),
  };
  trackedPods.set(`${namespace}/${name}`, entry);
  const current = await api.get(
    { kind: "Pod", namespace, name },
    abortSignal(config.timeouts.requestMs),
  );
  validateNamespaceAndPodOwnership(current, run, inventoryId, labels);
  for (const key of ["praetorium.io/runtime-epoch", "arcadia.io/generation"]) {
    assert.equal(
      Object.hasOwn(metadataOf(current).labels ?? {}, key),
      false,
      `unbound writer must omit managed ${key}`,
    );
  }
  assert.equal(metadataOf(current).uid, entry.uid);
  const status = podStatus(current);
  assert.ok(
    ["Pending", "Running"].includes(status.phase),
    "test unbound writer must be present in the live API census",
  );
  await waitForPodRunning(api, entry, config);
  return entry;
}

async function runAcceptance({ inventory, config, credentialFiles }) {
  const run = runId();
  const helperNamespace = config.cluster.instanceAccessNamespace;
  const idA = crockfordId();
  const idB = crockfordId();
  assert.notEqual(idA, idB);
  const specA = runtimeSpec(config, idA, config.network.hostnameSuffix);
  const specB = runtimeSpec(config, idB, config.network.hostnameSuffix);
  const specs = [specA, specB];
  for (const spec of specs) {
    assert.ok(
      validRunNamespace(runtimeNamespace(config, spec.instanceId), config.cluster.namespacePrefix),
    );
  }

  // Both transports use only explicit private inputs. The operator controller
  // token creates exact run-owned fixtures; production provider calls use only
  // the target Provisioner ServiceAccount token and prove that identity first.
  const transportOptions = {
    env: {
      KUBERNETES_SERVICE_HOST: config.cluster.apiHost,
      KUBERNETES_SERVICE_PORT_HTTPS: String(config.cluster.apiPort),
    },
    caPath: credentialFiles.caPath,
    requestTimeoutMs: config.timeouts.requestMs,
  };
  const providerTransport = new InClusterKubernetesTransport({
    ...transportOptions,
    tokenPath: credentialFiles.providerTokenPath,
  });
  await verifyProvisionerIdentity(providerTransport, runtimeNamespace(config, specA.instanceId));
  const controllerTransport = new InClusterKubernetesTransport({
    ...transportOptions,
    tokenPath: credentialFiles.controllerTokenPath,
  });
  const guard = effectGuard(run, inventory, config);
  const providerApi = guardKubernetesApi(new KubernetesApiClient(providerTransport), guard);
  const controllerApi = guardKubernetesApi(new KubernetesApiClient(controllerTransport), guard);
  const reservations = new TestControllerReservations(config.cluster.id, specs);
  const runtime = makeRuntime(config, providerApi, reservations);
  const trackedPods = new Map();
  const providerOwnedSpecs = new Set();
  let primaryError;
  let cleanupFailure;

  try {
    const appNamespaceA = runtimeNamespace(config, specA.instanceId);
    const appNamespaceB = runtimeNamespace(config, specB.instanceId);
    const [namespaceA, namespaceB] = await Promise.all([
      getNamespaceOptional(providerApi, appNamespaceA),
      getNamespaceOptional(providerApi, appNamespaceB),
    ]);
    assert.equal(
      namespaceA,
      undefined,
      "random runtime namespace A already exists; refusing to touch it",
    );
    assert.equal(
      namespaceB,
      undefined,
      "random runtime namespace B already exists; refusing to touch it",
    );
    await preflightIngress(
      config,
      credentialFiles.ingressCa,
      `${run}.${config.network.hostnameSuffix}`,
    );
    await preflightPublicEgress(config);
    const clusterProof = await preflightCluster(config, controllerApi, runtime);

    // Prove the control API is live and reachable from a run-owned Pod using
    // the exact Prometheus source allowed by the deployed system NetworkPolicy.
    await runControlApiProbe({
      api: controllerApi,
      config,
      controlHealthTarget: clusterProof.controlHealthTarget,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
    });

    // The real provider makes all tenant resource changes and obtains only live Node/Pod capacity.
    reservations.setStatus(specA.instanceId, "reserved");
    reservations.setStatus(specB.instanceId, "reserved");
    providerOwnedSpecs.add(specA);
    providerOwnedSpecs.add(specB);
    await createRuntimeAndWait(runtime, specA, guard, config);
    await createRuntimeAndWait(runtime, specB, guard, config);
    const twoWriterCapacity = await runtime.getCapacitySnapshot(
      undefined,
      config.cluster.resourceProfile.id,
    );
    assert.equal(twoWriterCapacity.authoritative, true);
    assert.equal(
      twoWriterCapacity.activeInstances >= 2,
      true,
      "provider live capacity census omitted a runtime writer",
    );
    assert.ok(
      twoWriterCapacity.nodeResourceVersion && twoWriterCapacity.podResourceVersion,
      "two-writer capacity must carry live observation versions",
    );

    await activateAndVerifyIngress({
      runtime,
      api: controllerApi,
      config,
      spec: specA,
      helperNamespace,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
      ca: credentialFiles.ingressCa,
      guard,
    });
    await activateAndVerifyIngress({
      runtime,
      api: controllerApi,
      config,
      spec: specB,
      helperNamespace,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
      ca: credentialFiles.ingressCa,
      guard,
    });

    // Provider census must see a selector-matching writer even when its managed
    // ownership labels are absent; it must leave the runtime stopped and pending.
    await stopRuntimeAndWait(runtime, providerApi, specA, guard, config);
    const unbound = await createUnboundWriter({
      api: controllerApi,
      config,
      spec: specA,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
    });
    const census = await runtime.inspect(specA, abortSignal(config.timeouts.requestMs));
    assert.equal(census.writerCensus.complete, true);
    assert.ok(
      census.writerCensus.pods.some((pod) => pod.uid === unbound.uid),
      "complete provider census omitted an unbound writer Pod",
    );
    const fenced = await runtime.ensureRunning(
      specA,
      abortSignal(config.timeouts.requestMs),
      guard,
    );
    assert.equal(
      fenced.status,
      "pending",
      "provider admitted a replacement while an unbound writer remained",
    );
    assert.ok(
      fenced.observation.writerCensus.pods.some((pod) => pod.uid === unbound.uid),
      "pending response omitted the unbound writer evidence",
    );
    await cleanupPod(
      controllerApi,
      trackedPods,
      `${unbound.namespace}/${unbound.name}`,
      run,
      inventory.inventoryId,
      config.timeouts.requestMs,
    );
    reservations.setStatus(specA.instanceId, "reserved");
    await createRuntimeAndWait(runtime, specA, guard, config);

    // One live, unscheduled test Pod must make authoritative capacity unknown.
    const unscheduled = await createUnknownCapacityPod({
      api: controllerApi,
      observerApi: providerApi,
      config,
      helperNamespace,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
    });
    const pendingCapacityPod = await controllerApi.get(
      { kind: "Pod", namespace: unscheduled.entry.namespace, name: unscheduled.entry.name },
      abortSignal(config.timeouts.requestMs),
    );
    assert.equal(
      podStatus(pendingCapacityPod).phase,
      "Pending",
      "unknown-capacity probe Pod unexpectedly scheduled",
    );
    await assert.rejects(
      runtime.getCapacitySnapshot(undefined, config.cluster.resourceProfile.id),
      (error) => error?.code === "capacity" || error?.statusCode === 422,
      "provider must fail closed when the live census contains an unscheduled Pod",
    );
    await cleanupPod(
      controllerApi,
      trackedPods,
      `${unscheduled.entry.namespace}/${unscheduled.entry.name}`,
      run,
      inventory.inventoryId,
      config.timeouts.requestMs,
    );
    const recoveredCapacity = await runtime.getCapacitySnapshot(
      undefined,
      config.cluster.resourceProfile.id,
    );
    assert.equal(
      recoveredCapacity.authoritative,
      true,
      "provider did not recover from a real cleaned unscheduled Pod",
    );

    // Run actual packets from tenant-labelled Pods. Stop only the source writer
    // to respect the provider's one-Pod ResourceQuota; keep the target serving.
    await stopRuntimeAndWait(runtime, providerApi, specA, guard, config);
    const peerBeforeA = await verifyRuntimePeer({
      runtime,
      api: controllerApi,
      config,
      spec: specB,
      helperNamespace,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
    });
    const controlBeforeA = await getLiveProvisionerHealthTarget(controllerApi);
    await runControlApiProbe({
      api: controllerApi,
      config,
      controlHealthTarget: controlBeforeA,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
    });
    await runTenantNetworkProbe({
      api: controllerApi,
      config,
      source: specA,
      target: specB,
      controlHealthUrl: controlBeforeA.url,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
    });
    const peerAfterA = await verifyRuntimePeer({
      runtime,
      api: controllerApi,
      config,
      spec: specB,
      helperNamespace,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
    });
    assert.equal(
      peerAfterA,
      peerBeforeA,
      "cross-instance peer writer changed during the denial probe",
    );
    const controlAfterA = await getLiveProvisionerHealthTarget(controllerApi);
    assert.equal(
      controlAfterA.uid,
      controlBeforeA.uid,
      "Provisioner Pod changed during the tenant private-endpoint denial probe",
    );
    await runControlApiProbe({
      api: controllerApi,
      config,
      controlHealthTarget: controlAfterA,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
    });
    const tenantAProbeKey = [...trackedPods.keys()].find((key) =>
      key.startsWith(`${appNamespaceA}/net-`),
    );
    await cleanupPod(
      controllerApi,
      trackedPods,
      tenantAProbeKey,
      run,
      inventory.inventoryId,
      config.timeouts.requestMs,
    );
    reservations.setStatus(specA.instanceId, "reserved");
    await createRuntimeAndWait(runtime, specA, guard, config);
    await activateAndVerifyIngress({
      runtime,
      api: controllerApi,
      config,
      spec: specA,
      helperNamespace,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
      ca: credentialFiles.ingressCa,
      guard,
    });

    await stopRuntimeAndWait(runtime, providerApi, specB, guard, config);
    const peerBeforeB = await verifyRuntimePeer({
      runtime,
      api: controllerApi,
      config,
      spec: specA,
      helperNamespace,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
    });
    const controlBeforeB = await getLiveProvisionerHealthTarget(controllerApi);
    await runControlApiProbe({
      api: controllerApi,
      config,
      controlHealthTarget: controlBeforeB,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
    });
    await runTenantNetworkProbe({
      api: controllerApi,
      config,
      source: specB,
      target: specA,
      controlHealthUrl: controlBeforeB.url,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
    });
    const peerAfterB = await verifyRuntimePeer({
      runtime,
      api: controllerApi,
      config,
      spec: specA,
      helperNamespace,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
    });
    assert.equal(
      peerAfterB,
      peerBeforeB,
      "cross-instance peer writer changed during the denial probe",
    );
    const controlAfterB = await getLiveProvisionerHealthTarget(controllerApi);
    assert.equal(
      controlAfterB.uid,
      controlBeforeB.uid,
      "Provisioner Pod changed during the tenant private-endpoint denial probe",
    );
    await runControlApiProbe({
      api: controllerApi,
      config,
      controlHealthTarget: controlAfterB,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
    });
    const tenantBProbeKey = [...trackedPods.keys()].find((key) =>
      key.startsWith(`${appNamespaceB}/net-`),
    );
    await cleanupPod(
      controllerApi,
      trackedPods,
      tenantBProbeKey,
      run,
      inventory.inventoryId,
      config.timeouts.requestMs,
    );
    reservations.setStatus(specB.instanceId, "reserved");
    await createRuntimeAndWait(runtime, specB, guard, config);
    await activateAndVerifyIngress({
      runtime,
      api: controllerApi,
      config,
      spec: specB,
      helperNamespace,
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
      ca: credentialFiles.ingressCa,
      guard,
    });

    const finalCapacity = await runtime.getCapacitySnapshot(
      undefined,
      config.cluster.resourceProfile.id,
    );
    assert.equal(finalCapacity.authoritative, true);
    assert.ok(finalCapacity.nodeResourceVersion && finalCapacity.podResourceVersion);
    assert.ok(guard.count > 0, "provider mutations did not pass through the runner's effect guard");
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = [];
    for (const key of [...trackedPods.keys()]) {
      try {
        await cleanupPod(
          controllerApi,
          trackedPods,
          key,
          run,
          inventory.inventoryId,
          config.timeouts.requestMs,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const spec of [...providerOwnedSpecs].reverse()) {
      try {
        const namespace = runtimeNamespace(config, spec.instanceId);
        const current = await getNamespaceOptional(providerApi, namespace);
        if (current !== undefined) {
          const labels = metadataOf(current).labels ?? {};
          assert.equal(
            labels[INSTANCE_LABEL],
            spec.instanceId,
            "cleanup found a runtime namespace not owned by this exact instance",
          );
          assert.equal(
            labels["arcadia.io/repository-id"],
            String(spec.repositoryId),
            "cleanup found a runtime namespace for a different repository",
          );
          await runtime.ensureRuntimeDeleted(spec, abortSignal(config.timeouts.readinessMs), guard);
          reservations.setStatus(spec.instanceId, "released");
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      cleanupFailure = new AggregateError(
        cleanupErrors,
        "T14 Kubernetes runner could not clean every exact run-owned resource",
      );
    }
  }
  if (primaryError && cleanupFailure) {
    throw new AggregateError(
      [primaryError, cleanupFailure],
      "T14 Kubernetes acceptance failed and cleanup was incomplete",
    );
  }
  if (cleanupFailure) throw cleanupFailure;
  if (primaryError) throw primaryError;
}

test("T14 Kubernetes private config validator rejects unowned, unsafe, or incomplete inputs", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const inventory = {
    schemaVersion: 1,
    inventoryId: "praetorium-t14-owned",
    owner: { name: "test operator", identity: "uid=1000" },
    environment: {
      name: "praetorium-t14-local",
      purpose: "t14-disposable-test",
      disposable: true,
      production: false,
      expiresAt: "2026-10-02T00:00:00Z",
    },
  };
  const valid = {
    schemaVersion: 1,
    inventory: {
      inventoryId: inventory.inventoryId,
      ownerIdentity: inventory.owner.identity,
      environmentName: inventory.environment.name,
      expiresAt: inventory.environment.expiresAt,
    },
    cluster: {
      id: "clu_00000000000000000000000001",
      provider: "kind",
      name: "praetorium-t14-local",
      context: "kind-praetorium-t14-local",
      confirmation: "praetorium-t14-local",
      apiHost: "127.0.0.1",
      apiPort: 6443,
      namespacePrefix: "praetorium-instances",
      ingressNamespace: "traefik",
      instanceAccessNamespace: "praetorium-system",
      maximumResources: { cpuMilli: 2_000, memoryMiB: 2_048, ephemeralStorageMiB: 4_096 },
      resourceProfile: { id: "small", cpuMilli: 250, memoryMiB: 256, ephemeralStorageMiB: 512 },
    },
    credentials: {
      directory: "/tmp/t14-private",
      controllerTokenPath: "/tmp/t14-private/controller-token",
      providerTokenPath: "/tmp/t14-private/provisioner-token",
      caPath: "/tmp/t14-private/ca.crt",
    },
    probe: {
      repositoryId: 700001,
      imageRef: `ghcr.io/praetorium/t14-probe@sha256:${"a".repeat(64)}`,
      imageDigest: `sha256:${"a".repeat(64)}`,
      platformManifestDigest: `sha256:${"b".repeat(64)}`,
      httpPort: PROBE_HTTP_PORT,
    },
    network: {
      hostnameSuffix: "instances.t14.example.test",
      ingressAddress: "127.0.0.1",
      ingressPort: 30443,
      ingressCaPath: "/tmp/t14-private/ingress-ca.crt",
      publicEgressUrl: "https://probe.example.net/marker",
      publicEgressMarker: "owned-egress-probe-v1",
    },
    timeouts: { requestMs: 5_000, readinessMs: 120_000, networkProbeMs: 10_000, totalMs: 600_000 },
  };
  assert.deepEqual(
    validateInventory(
      {
        ...inventory,
        resources: {
          [CATEGORY]: {
            state: "available",
            owner: inventory.owner.identity,
            disposable: true,
            production: false,
            reference: "/tmp/t14-private/config.json",
          },
        },
      },
      now,
    ),
    [],
  );
  assert.deepEqual(validateConfig(valid, inventory, now), []);
  assert.ok(
    validateConfig(
      { ...valid, cluster: { ...valid.cluster, apiHost: "203.0.113.10" } },
      inventory,
      now,
    ).some((error) => error.includes("loopback")),
  );
  assert.ok(
    validateConfig(
      { ...valid, cluster: { ...valid.cluster, ingressNamespace: "custom-traefik" } },
      inventory,
      now,
    ).some((error) => error.includes("tenant ingress policy namespace")),
  );
  assert.ok(
    validateConfig(
      { ...valid, probe: { ...valid.probe, imageRef: "ghcr.io/praetorium/t14-probe:latest" } },
      inventory,
      now,
    ).some((error) => error.includes("immutable")),
  );
  assert.ok(
    validateConfig(
      { ...valid, probe: { ...valid.probe, platformManifestDigest: "latest" } },
      inventory,
      now,
    ).some((error) => error.includes("immutable")),
  );
  assert.ok(
    validateConfig(
      { ...valid, network: { ...valid.network, publicEgressUrl: "http://127.0.0.1/" } },
      inventory,
      now,
    ).some((error) => error.includes("public HTTPS")),
  );
  assert.ok(
    validateConfig(
      {
        ...valid,
        cluster: {
          ...valid.cluster,
          resourceProfile: { ...valid.cluster.resourceProfile, cpuMilli: 5_000 },
        },
      },
      inventory,
      now,
    ).some((error) => error.includes("must not exceed")),
  );
  assert.ok(
    validateConfig({ ...valid, command: "kubectl delete namespace default" }, inventory, now).some(
      (error) => error.includes("exactly"),
    ),
  );
  assert.ok(
    validateInventory(
      {
        ...inventory,
        environment: { ...inventory.environment, production: true },
        resources: {
          [CATEGORY]: {
            state: "available",
            owner: inventory.owner.identity,
            disposable: true,
            production: false,
            reference: "/tmp/t14-private/config.json",
          },
        },
      },
      now,
    ).some((error) => error.includes("nonproduction")),
  );
});

test(
  "T14 Kubernetes provider acceptance uses the explicit owned disposable cluster",
  { timeout: 1_260_000 },
  async () => {
    const inputs = await loadOwnedInputs();
    await runAcceptance(inputs);
  },
);
