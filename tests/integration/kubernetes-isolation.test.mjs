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
  runtimeNamespaceName,
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
const METADATA_FIXTURE_LABEL = "praetorium.io/t14-metadata-fixture";
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

function exactKeys(value, expected, field, errors, optional = []) {
  if (!isRecord(value)) {
    errors.push(`${field} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const allowed = new Set([...wanted, ...optional]);
  if (actual.some((key) => !allowed.has(key)) || wanted.some((key) => !actual.includes(key))) {
    errors.push(
      `${field} must contain exactly: ${wanted.join(", ")}${optional.length ? `; optional: ${optional.join(", ")}` : ""}`,
    );
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeAbsolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

function isOwnedFreshClusterName(value) {
  return (
    typeof value === "string" &&
    value.length <= 63 &&
    /^praetorium-owned-kube-fresh-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value)
  );
}

function isAcceptedClusterName(value) {
  return (
    typeof value === "string" &&
    (/^praetorium-t14-[a-z0-9-]{1,23}[a-z0-9]$/u.test(value) || isOwnedFreshClusterName(value))
  );
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
    [
      "schemaVersion",
      "inventory",
      "cluster",
      "credentials",
      "metadataFixture",
      "probe",
      "network",
      "timeouts",
    ],
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
    ["ownerMarkerPath"],
  );
  if (!/^clu_[0-9A-HJKMNP-TV-Z]{26}$/u.test(config?.cluster?.id ?? "")) {
    errors.push("config.cluster.id must be an opaque Kubernetes cluster identifier");
  }
  if (config?.cluster?.provider !== "kind") errors.push("config.cluster.provider must be kind");
  if (!isAcceptedClusterName(config?.cluster?.name)) {
    errors.push(
      "config.cluster.name must identify an explicitly disposable T14 Kind cluster or the owner-marked praetorium-owned-kube-fresh cluster",
    );
  }
  if (config?.cluster?.context !== `kind-${config?.cluster?.name}`) {
    errors.push("config.cluster.context must be the exact Kind context for the cluster name");
  }
  if (config?.cluster?.confirmation !== config?.cluster?.name) {
    errors.push("config.cluster.confirmation must repeat the explicit disposable cluster name");
  }
  if (
    (isOwnedFreshClusterName(config?.cluster?.name) &&
      !safeAbsolutePath(config?.cluster?.ownerMarkerPath)) ||
    (config?.cluster?.ownerMarkerPath !== undefined &&
      !safeAbsolutePath(config.cluster.ownerMarkerPath))
  ) {
    errors.push(
      "config.cluster.ownerMarkerPath must name the private owner marker for an existing owned Kind cluster",
    );
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
    ["directory", "controllerIdentity", "controllerTokenPath", "providerTokenPath", "caPath"],
    "config.credentials",
    errors,
  );
  for (const key of ["directory", "controllerTokenPath", "providerTokenPath", "caPath"]) {
    if (!safeAbsolutePath(config?.credentials?.[key])) {
      errors.push(`config.credentials.${key} must be an absolute path`);
    }
  }
  if (!/^[\x21-\x7e]{1,256}$/u.test(config?.credentials?.controllerIdentity ?? "")) {
    errors.push("config.credentials.controllerIdentity must be an explicit Kubernetes username");
  }

  exactKeys(
    config?.metadataFixture,
    [
      "inventoryId",
      "ownerIdentity",
      "environmentName",
      "expiresAt",
      "fixtureId",
      "marker",
      "routeAttestation",
      "serviceName",
      "serviceUid",
      "endpointsUid",
      "podName",
      "podUid",
      "podIp",
      "imageRef",
      "imageDigest",
      "platformManifestDigest",
      "resources",
    ],
    "config.metadataFixture",
    errors,
  );
  for (const key of ["inventoryId", "ownerIdentity", "environmentName", "expiresAt"]) {
    if (config?.metadataFixture?.[key] !== config?.inventory?.[key]) {
      errors.push(`config.metadataFixture.${key} must match the owned inventory`);
    }
  }
  if (!/^[a-f0-9]{32}$/u.test(config?.metadataFixture?.fixtureId ?? "")) {
    errors.push(
      "config.metadataFixture.fixtureId must be a unique 128-bit lowercase hex identifier",
    );
  }
  const metadataFixtureId = config?.metadataFixture?.fixtureId ?? "";
  if (
    config?.metadataFixture?.routeAttestation !==
    `t14-owned-route:${config?.inventory?.inventoryId}:${metadataFixtureId}`
  ) {
    errors.push(
      "config.metadataFixture.routeAttestation must explicitly attest this inventory and fixture route",
    );
  }
  if (config?.metadataFixture?.serviceName !== `t14-meta-s-${metadataFixtureId.slice(0, 20)}`) {
    errors.push(
      "config.metadataFixture.serviceName must be the unique derived canary Service name",
    );
  }
  if (config?.metadataFixture?.podName !== `t14-meta-p-${metadataFixtureId.slice(12)}`) {
    errors.push("config.metadataFixture.podName must be the unique derived canary Pod name");
  }
  for (const key of ["serviceUid", "endpointsUid", "podUid"]) {
    if (!/^[A-Za-z0-9-]{16,128}$/u.test(config?.metadataFixture?.[key] ?? "")) {
      errors.push(`config.metadataFixture.${key} must be an explicit live Kubernetes UID`);
    }
  }
  if (isIP(config?.metadataFixture?.podIp ?? "") === 0) {
    errors.push("config.metadataFixture.podIp must be the explicit canary Pod IP");
  }
  const metadataImageRef = config?.metadataFixture?.imageRef;
  const metadataImageDigest = config?.metadataFixture?.imageDigest;
  if (
    typeof metadataImageRef !== "string" ||
    !/^[a-z0-9][a-z0-9./:_-]{0,254}@sha256:[0-9a-f]{64}$/u.test(metadataImageRef) ||
    !DIGEST.test(metadataImageDigest ?? "") ||
    !metadataImageRef.endsWith(`@${metadataImageDigest}`) ||
    !DIGEST.test(config?.metadataFixture?.platformManifestDigest ?? "")
  ) {
    errors.push(
      "config.metadataFixture must identify its immutable canary image and platform digest",
    );
  }
  safeResourceQuantities(
    config?.metadataFixture?.resources,
    "config.metadataFixture.resources",
    errors,
  );
  for (const key of ["cpuMilli", "memoryMiB", "ephemeralStorageMiB"]) {
    if (
      Number.isSafeInteger(config?.metadataFixture?.resources?.[key]) &&
      Number.isSafeInteger(config?.cluster?.maximumResources?.[key]) &&
      config.metadataFixture.resources[key] > config.cluster.maximumResources[key]
    ) {
      errors.push(
        `config.metadataFixture.resources.${key} must not exceed cluster.maximumResources`,
      );
    }
  }
  if (!/^t14-metadata-[a-f0-9]{64}$/u.test(config?.metadataFixture?.marker ?? "")) {
    errors.push(
      "config.metadataFixture.marker must be an unguessable 256-bit marker for the owned canary",
    );
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

function validateClusterOwnerMarker(marker, config, now = Date.now()) {
  const errors = [];
  if (!isRecord(marker)) return ["owned Kind cluster marker must be an object"];
  if (marker.schema !== "praetorium.local-kind-owner/v1") {
    errors.push("owned Kind cluster marker schema is unsupported");
  }
  if (!nonEmpty(marker.owner)) errors.push("owned Kind cluster marker owner is required");
  if (
    !Number.isSafeInteger(marker.uid) ||
    (typeof process.getuid === "function" && marker.uid !== process.getuid())
  ) {
    errors.push("owned Kind cluster marker UID must match the current operator");
  }
  if (!nonEmpty(marker.purpose)) errors.push("owned Kind cluster marker purpose is required");
  const createdAt = Date.parse(marker.createdAt ?? "");
  if (!Number.isFinite(createdAt) || createdAt > now) {
    errors.push("owned Kind cluster marker creation time is invalid");
  }
  if (marker.disposable !== true) errors.push("owned Kind cluster marker must be disposable");
  if (marker.production !== false) errors.push("owned Kind cluster marker must be nonproduction");
  const expiresAt = Date.parse(marker.expiresAt ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    errors.push("owned Kind cluster marker is expired or has no explicit expiry");
  }
  if (marker.clusterName !== config?.cluster?.name) {
    errors.push("owned Kind cluster marker name must match config.cluster.name");
  }
  if (marker.clusterId !== config?.cluster?.id) {
    errors.push("owned Kind cluster marker cluster ID must match config.cluster.id");
  }
  if (marker.context !== config?.cluster?.context) {
    errors.push("owned Kind cluster marker context must match config.cluster.context");
  }
  if (marker.apiHost !== config?.cluster?.apiHost) {
    errors.push("owned Kind cluster marker API host must match config.cluster.apiHost");
  }
  if (marker.apiPort !== config?.cluster?.apiPort) {
    errors.push("owned Kind cluster marker API port must match config.cluster.apiPort");
  }
  return [...new Set(errors)];
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
  let clusterOwnerMarker;
  if (config.cluster.ownerMarkerPath !== undefined) {
    clusterOwnerMarker = await readJsonFile(config.cluster.ownerMarkerPath, { privateFile: true });
    assert.deepEqual(
      validateClusterOwnerMarker(clusterOwnerMarker, config),
      [],
      "existing Kind cluster owner marker does not match the selected disposable cluster",
    );
  }
  if (isOwnedFreshClusterName(config.cluster.name)) {
    assert.ok(clusterOwnerMarker, "existing owned Kind cluster requires its owner marker");
  }
  const credentialFiles = await validateCredentialFiles(config);
  return { inventory, config, credentialFiles, clusterOwnerMarker };
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

function runtimeNamespace(config, instanceId) {
  return runtimeNamespaceName(config.cluster.namespacePrefix, instanceId);
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

function makeRenderer(config) {
  const maximumResources = {
    cpuMilli: config.cluster.maximumResources.cpuMilli,
    memoryMiB: config.cluster.maximumResources.memoryMiB,
    ephemeralStorageMiB: config.cluster.maximumResources.ephemeralStorageMiB,
  };
  return createKubernetesResourceRenderer({
    namespacePrefix: config.cluster.namespacePrefix,
    clusterId: config.cluster.id,
    ingressNamespace: config.cluster.ingressNamespace,
    instanceAccessNamespace: config.cluster.instanceAccessNamespace,
    instanceAccessService: "instance-access",
    controlNamespace: "praetorium-system",
    controlService: "provisioner",
    maximumResources,
  });
}

function makeRuntime(config, api, reservations) {
  return new KubernetesRuntimeProvider({
    api,
    namespacePrefix: config.cluster.namespacePrefix,
    clusterId: config.cluster.id,
    renderer: makeRenderer(config),
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

async function verifyRuntimeDeletion(api, runtime, spec, config, guard) {
  const namespace = runtimeNamespace(config, spec.instanceId);
  const result = await runtime.ensureRuntimeDeleted(
    spec,
    abortSignal(config.timeouts.readinessMs),
    guard,
  );
  assert.equal(
    result.status,
    "applied",
    `provider runtime cleanup for ${spec.instanceId} remains pending`,
  );
  assert.equal(result.observation.state, "absent", "deleted runtime is still observed");
  assert.equal(
    result.observation.writerCensus.complete,
    true,
    "cleanup writer census is incomplete",
  );
  assert.equal(result.observation.writerCensus.queriedPodCount, 0, "cleanup left runtime writers");

  const retainedNamespace = await api.getNamespace(namespace);
  assert.equal(
    namespaceOf(retainedNamespace),
    namespace,
    "provider cleanup removed the retained namespace",
  );
  const labels = metadataOf(retainedNamespace).labels ?? {};
  for (const [key, expected] of Object.entries({
    [PLATFORM_LABEL_KEY]: PLATFORM_LABEL_VALUE,
    [MANAGED_BY_LABEL_KEY]: MANAGED_BY_LABEL_VALUE,
    [INSTANCE_LABEL]: spec.instanceId,
    [REPOSITORY_LABEL_KEY]: String(spec.repositoryId),
    [OWNERSHIP_LABEL_KEY]: OWNERSHIP_VERSION,
    [CLUSTER_LABEL_KEY]: config.cluster.id,
    "pod-security.kubernetes.io/enforce": "restricted",
    "pod-security.kubernetes.io/audit": "restricted",
    "pod-security.kubernetes.io/warn": "restricted",
  })) {
    assert.equal(labels[key], expected, `retained namespace ownership changed at ${key}`);
  }

  const name = runtimeService(spec.instanceId);
  for (const reference of [
    { kind: "Service", name },
    { kind: "NetworkPolicy", name: `${name}-network` },
    { kind: "ResourceQuota", name: `${name}-quota` },
    { kind: "LimitRange", name: `${name}-limits` },
    { kind: "ServiceAccount", name: `${name}-app` },
    { kind: "RoleBinding", name: "praetorium-provisioner-runtime" },
    { kind: "Deployment", name },
    { kind: "IngressRoute", name },
  ]) {
    try {
      await api.get({ ...reference, namespace });
      assert.fail(`provider cleanup left ${reference.kind} ${namespace}/${reference.name}`);
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404) continue;
      throw error;
    }
  }
}

async function listAll(api, kind, namespace, labelSelector = "") {
  const items = [];
  let cursor;
  const cursors = new Set();
  do {
    const page = await api.list(kind, namespace, labelSelector, cursor);
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

function assertClusterNodeOwnership(nodes, clusterId) {
  assert.ok(nodes.length > 0, "owned Kind cluster has no live nodes");
  for (const node of nodes) {
    const labels = metadataOf(node).labels ?? {};
    assert.equal(
      labels["praetorium.io/cluster-id"],
      clusterId,
      "live Kind node cluster ID does not match the owned inventory",
    );
    assert.equal(
      labels["praetorium.io/disposable"],
      "true",
      "live Kind node is not marked disposable",
    );
  }
}

function effectGuard(run, inventory, config, clusterOwnerMarker) {
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
    assert.ok(isAcceptedClusterName(config.cluster.name), "runner cluster identity changed");
    if (isOwnedFreshClusterName(config.cluster.name)) {
      assert.deepEqual(
        validateClusterOwnerMarker(clusterOwnerMarker, config),
        [],
        "existing owned Kind cluster identity changed during execution",
      );
    }
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

async function getLiveProvisionerHealthTarget(
  controllerApi,
  controllerTransport,
  expectedDeploymentUid,
  requestMs,
) {
  const namespace = "praetorium-system";
  const deployment = await controllerApi.get({
    kind: "Deployment",
    namespace,
    name: "praetorium-provisioner",
  });
  const deploymentUid = objectUid(deployment);
  assert.equal(
    deploymentUid,
    expectedDeploymentUid,
    "Provisioner Deployment UID changed during the isolation run",
  );
  assert.deepEqual(
    deployment?.spec?.selector?.matchLabels,
    { [APP_LABEL]: "provisioner" },
    "Provisioner Deployment selector changed during the isolation run",
  );
  assert.equal(
    deployment?.spec?.template?.spec?.serviceAccountName,
    "praetorium-provisioner",
    "Provisioner Deployment ServiceAccount changed during the isolation run",
  );

  const replicaSets = [];
  let continueToken;
  const cursors = new Set();
  do {
    const query = new URLSearchParams({ labelSelector: `${APP_LABEL}=provisioner`, limit: "500" });
    if (continueToken !== undefined) query.set("continue", continueToken);
    const response = await controllerTransport.request({
      method: "GET",
      path: `/apis/apps/v1/namespaces/${namespace}/replicasets?${query.toString()}`,
      headers: { accept: "application/json" },
      signal: abortSignal(requestMs),
    });
    assert.equal(response.statusCode, 200, "Provisioner ReplicaSets are unavailable");
    assert.equal(response.body?.kind, "ReplicaSetList");
    assert.ok(Array.isArray(response.body?.items));
    replicaSets.push(...response.body.items);
    assert.ok(replicaSets.length <= 2_000, "Provisioner ReplicaSet observation exceeded its bound");
    continueToken = response.body?.metadata?.continue || undefined;
    if (continueToken !== undefined) {
      assert.equal(cursors.has(continueToken), false, "ReplicaSet pagination repeated a cursor");
      cursors.add(continueToken);
    }
  } while (continueToken !== undefined);

  const ownedReplicaSets = replicaSets.filter((replicaSet) => {
    const owners = metadataOf(replicaSet).ownerReferences ?? [];
    return (
      owners.filter(
        (owner) =>
          owner?.kind === "Deployment" &&
          owner?.name === "praetorium-provisioner" &&
          owner?.uid === deploymentUid &&
          owner?.controller === true,
      ).length === 1 &&
      replicaSet?.spec?.template?.spec?.serviceAccountName === "praetorium-provisioner"
    );
  });
  assert.ok(ownedReplicaSets.length > 0, "Provisioner Deployment owns no matching ReplicaSet");
  const replicaSetUids = new Set(ownedReplicaSets.map((replicaSet) => objectUid(replicaSet)));
  const provisionerPods = await listAll(
    controllerApi,
    "Pod",
    namespace,
    `${APP_LABEL}=provisioner`,
  );
  const liveProvisionerPod = provisionerPods.find((pod) => {
    const controllerOwners = (metadataOf(pod).ownerReferences ?? []).filter(
      (owner) => owner?.controller === true,
    );
    const podLabels = metadataOf(pod).labels ?? {};
    return (
      controllerOwners.length === 1 &&
      controllerOwners[0]?.kind === "ReplicaSet" &&
      replicaSetUids.has(controllerOwners[0]?.uid) &&
      ownedReplicaSets.some(
        (replicaSet) =>
          metadataOf(replicaSet).uid === controllerOwners[0]?.uid &&
          metadataOf(replicaSet).name === controllerOwners[0]?.name,
      ) &&
      pod?.spec?.serviceAccountName === "praetorium-provisioner" &&
      Object.entries(deployment.spec.selector.matchLabels).every(
        ([key, value]) => podLabels[key] === value,
      ) &&
      pod?.status?.phase === "Running" &&
      typeof pod?.status?.podIP === "string" &&
      isIP(pod.status.podIP) !== 0 &&
      pod?.status?.containerStatuses?.some(
        (container) => container?.name === "provisioner" && container?.state?.running,
      )
    );
  });
  assert.ok(
    liveProvisionerPod,
    "actual Provisioner Deployment has no running Pod owned through its ReplicaSet and exact ServiceAccount",
  );
  const controlHost =
    isIP(liveProvisionerPod.status.podIP) === 6
      ? `[${liveProvisionerPod.status.podIP}]`
      : liveProvisionerPod.status.podIP;
  return {
    uid: objectUid(liveProvisionerPod),
    deploymentUid,
    replicaSetUid: liveProvisionerPod.metadata.ownerReferences.find(
      (owner) => owner?.controller === true,
    ).uid,
    url: `http://${controlHost}:8080/healthz`,
  };
}

async function verifyMetadataFixture(config, controllerApi, controllerTransport) {
  const fixture = config.metadataFixture;
  const namespace = "praetorium-system";
  const service = await controllerApi.get({
    kind: "Service",
    namespace,
    name: fixture.serviceName,
  });
  assert.equal(metadataOf(service).uid, fixture.serviceUid, "metadata canary Service UID changed");
  assert.equal(metadataOf(service).namespace, namespace);
  assert.deepEqual(
    metadataOf(service).labels?.[INVENTORY_LABEL],
    config.inventory.inventoryId,
    "metadata canary Service does not belong to the owned acceptance inventory",
  );
  assert.deepEqual(
    metadataOf(service).labels?.[METADATA_FIXTURE_LABEL],
    fixture.fixtureId,
    "metadata canary Service fixture identity changed",
  );
  assert.equal(
    service?.spec?.type,
    "ClusterIP",
    "metadata canary Service must use ClusterIP routing",
  );
  assert.deepEqual(
    service?.spec?.externalIPs,
    ["169.254.169.254"],
    "metadata canary Service must own only the fixed link-local test address",
  );
  assert.ok(
    isIP(service?.spec?.clusterIP ?? "") !== 0,
    "metadata canary Service must have a live ClusterIP",
  );
  assert.deepEqual(
    service?.spec?.selector,
    { [METADATA_FIXTURE_LABEL]: fixture.fixtureId },
    "metadata canary Service selector is not the exact owned fixture",
  );
  assert.equal(Array.isArray(service?.spec?.ports), true);
  assert.equal(service.spec.ports.length, 1);
  assert.deepEqual(service.spec.ports[0], {
    name: "http",
    port: 80,
    targetPort: 8080,
    protocol: "TCP",
  });

  const endpointsResponse = await controllerTransport.request({
    method: "GET",
    path: `/api/v1/namespaces/${namespace}/endpoints/${fixture.serviceName}`,
    headers: { accept: "application/json" },
    signal: abortSignal(config.timeouts.requestMs),
  });
  assert.equal(endpointsResponse.statusCode, 200, "metadata canary Endpoints are unavailable");
  const endpoints = endpointsResponse.body;
  assert.equal(endpoints?.kind, "Endpoints", "metadata canary API response is not Endpoints");
  assert.equal(metadataOf(endpoints).name, fixture.serviceName);
  assert.equal(metadataOf(endpoints).namespace, namespace);
  assert.equal(
    metadataOf(endpoints).uid,
    fixture.endpointsUid,
    "metadata canary Endpoints UID changed",
  );
  assert.equal(Array.isArray(endpoints?.subsets), true);
  assert.equal(
    endpoints.subsets.length,
    1,
    "metadata canary must have exactly one endpoint subset",
  );
  assert.equal(
    endpoints.subsets[0]?.addresses?.length,
    1,
    "metadata canary must have one ready target",
  );
  assert.equal(endpoints.subsets[0]?.notReadyAddresses?.length ?? 0, 0);
  assert.equal(endpoints.subsets[0].addresses[0]?.ip, fixture.podIp);
  const targetRef = endpoints.subsets[0].addresses[0]?.targetRef;
  assert.equal(targetRef?.kind, "Pod");
  assert.equal(targetRef?.name, fixture.podName);
  assert.equal(targetRef?.namespace, namespace);
  assert.equal(targetRef?.uid, fixture.podUid);
  assert.deepEqual(endpoints.subsets[0]?.ports, [{ name: "http", port: 8080, protocol: "TCP" }]);

  const pod = await controllerApi.get({ kind: "Pod", namespace, name: fixture.podName });
  assert.equal(metadataOf(pod).uid, fixture.podUid, "metadata canary Pod UID changed");
  assert.equal(metadataOf(pod).namespace, namespace);
  const podLabels = metadataOf(pod).labels ?? {};
  assert.equal(podLabels[INVENTORY_LABEL], config.inventory.inventoryId);
  assert.equal(podLabels[METADATA_FIXTURE_LABEL], fixture.fixtureId);
  assert.equal(podLabels[PROBE_APP_LABEL], "metadata-fixture");
  assert.equal(pod?.spec?.automountServiceAccountToken, false);
  assert.equal(pod?.spec?.hostNetwork ?? false, false);
  assert.equal(pod?.spec?.hostPID ?? false, false);
  assert.equal(pod?.spec?.hostIPC ?? false, false);
  assert.equal(pod?.spec?.securityContext?.runAsNonRoot, true);
  assert.equal(pod?.spec?.securityContext?.seccompProfile?.type, "RuntimeDefault");
  assert.equal(
    (pod?.spec?.volumes ?? []).some((volume) => Object.hasOwn(volume, "hostPath")),
    false,
    "metadata canary Pod must not use host paths",
  );
  assert.equal(Array.isArray(pod?.spec?.containers), true);
  assert.equal(pod.spec.containers.length, 1);
  assert.equal((pod?.spec?.initContainers ?? []).length, 0);
  assert.deepEqual(pod?.spec?.volumes ?? [], [], "metadata canary Pod must not mount any volumes");
  const container = pod.spec.containers[0];
  assert.equal(container?.name, "metadata-fixture");
  assert.equal(container?.image, fixture.imageRef);
  assert.equal(
    container?.command,
    undefined,
    "metadata canary must use its immutable image entrypoint",
  );
  assert.equal(
    container?.args,
    undefined,
    "metadata canary must use its immutable image entrypoint",
  );
  assert.deepEqual(container?.env, [
    { name: "T14_METADATA_FIXTURE_ID", value: fixture.fixtureId },
    { name: "T14_METADATA_MARKER", value: fixture.marker },
  ]);
  assert.equal(
    container?.envFrom,
    undefined,
    "metadata canary must not load undeclared environment data",
  );
  assert.deepEqual(container?.ports, [{ name: "http", containerPort: 8080, protocol: "TCP" }]);
  const security = container?.securityContext;
  assert.equal(security?.runAsNonRoot, true);
  assert.equal(security?.allowPrivilegeEscalation, false);
  assert.equal(security?.privileged ?? false, false);
  assert.equal(security?.readOnlyRootFilesystem, true);
  assert.equal(security?.seccompProfile?.type, "RuntimeDefault");
  assert.ok(security?.capabilities?.drop?.includes("ALL"));
  const quantities = {
    cpu: `${fixture.resources.cpuMilli}m`,
    memory: `${fixture.resources.memoryMiB}Mi`,
    "ephemeral-storage": `${fixture.resources.ephemeralStorageMiB}Mi`,
  };
  assert.deepEqual(container?.resources?.requests, quantities);
  assert.deepEqual(container?.resources?.limits, quantities);
  const ready = pod?.status?.conditions?.some(
    (condition) => condition?.type === "Ready" && condition?.status === "True",
  );
  assert.equal(pod?.status?.phase, "Running", "metadata canary Pod is not running");
  assert.equal(ready, true, "metadata canary Pod is not ready");
  assert.equal(pod?.status?.podIP, fixture.podIp);
  assert.equal(pod?.status?.containerStatuses?.length, 1);
  const containerStatus = pod.status.containerStatuses[0];
  assert.equal(containerStatus?.name, "metadata-fixture");
  assert.equal(containerStatus?.state?.running !== undefined, true);
  assert.equal(
    digestFromImageId(containerStatus?.imageID),
    fixture.platformManifestDigest,
    "metadata canary actual imageID does not match its configured immutable platform digest",
  );
  return {
    serviceUid: fixture.serviceUid,
    endpointsUid: fixture.endpointsUid,
    podUid: fixture.podUid,
  };
}

async function preflightCluster(config, controllerApi, controllerTransport, provider) {
  assertClusterNodeOwnership(await listAll(controllerApi, "Node", ""), config.cluster.id);
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

  await verifyMetadataFixture(config, controllerApi, controllerTransport);

  let provisionerDeploymentUid;
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
    if (service.label === "provisioner") {
      provisionerDeploymentUid = objectUid(deployment);
    }
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
  assert.ok(provisionerDeploymentUid, "target Provisioner Deployment has no explicit live UID");
  const controlHealthTarget = await getLiveProvisionerHealthTarget(
    controllerApi,
    controllerTransport,
    provisionerDeploymentUid,
    config.timeouts.requestMs,
  );
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
    provisionerDeploymentUid,
  };
}

async function selfReview(transport, apiVersion, review, signal) {
  const resource =
    review.kind === "SelfSubjectAccessReview" ? "selfsubjectaccessreviews" : "selfsubjectreviews";
  const response = await transport.request({
    method: "POST",
    path: `/apis/${apiVersion}/${resource}`,
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

async function verifyControllerIdentityAndPermissions(
  transport,
  expectedUsername,
  runtimeNamespaces,
  requestMs,
) {
  const authentication = await selfReview(
    transport,
    "authentication.k8s.io/v1",
    { apiVersion: "authentication.k8s.io/v1", kind: "SelfSubjectReview", spec: {} },
    abortSignal(requestMs),
  );
  const userInfo = authentication?.status?.userInfo;
  assert.equal(
    userInfo?.username,
    expectedUsername,
    "test-controller Kubernetes API credential is not the explicitly configured identity",
  );
  assert.ok(Array.isArray(userInfo?.groups), "test-controller identity omitted its groups");
  assert.equal(
    userInfo.groups.includes("system:masters"),
    false,
    "test-controller credential must not belong to system:masters",
  );
  assert.notEqual(
    userInfo.username,
    "system:anonymous",
    "test-controller credential must be authenticated",
  );

  const review = async (attributes, expected, description) => {
    const response = await selfReview(
      transport,
      "authorization.k8s.io/v1",
      {
        apiVersion: "authorization.k8s.io/v1",
        kind: "SelfSubjectAccessReview",
        spec: { resourceAttributes: attributes },
      },
      abortSignal(requestMs),
    );
    assert.equal(
      response?.status?.allowed,
      expected,
      `test-controller permission boundary failed for ${description}`,
    );
    assert.equal(
      response?.status?.evaluationError,
      undefined,
      `Kubernetes could not evaluate test-controller permission for ${description}`,
    );
  };
  const attributes = (verb, group, resource, namespace, name) => ({
    verb,
    group,
    version: "v1",
    resource,
    ...(namespace === undefined ? {} : { namespace }),
    ...(name === undefined ? {} : { name }),
  });

  for (const namespace of [
    "kube-system",
    "praetorium-system",
    CONTROL_PROBE_NAMESPACE,
    "traefik",
  ]) {
    await review(
      attributes("get", "", "namespaces", undefined, namespace),
      true,
      `read namespace ${namespace}`,
    );
  }
  for (const [namespace, resources] of [
    ["praetorium-system", ["services", "deployments", "serviceaccounts", "configmaps"]],
    [CONTROL_PROBE_NAMESPACE, ["services", "deployments"]],
  ]) {
    for (const resource of resources) {
      await review(
        attributes("get", "", resource, namespace),
        true,
        `read ${resource} in ${namespace}`,
      );
    }
  }
  await review(
    attributes("get", "rbac.authorization.k8s.io", "rolebindings", "praetorium-system"),
    true,
    "confirm dry-run RoleBinding absence in praetorium-system",
  );
  await review(
    attributes("list", "apps", "replicasets", "praetorium-system"),
    true,
    "verify the Provisioner Deployment owner chain",
  );
  await review(
    attributes("get", "", "endpoints", "praetorium-system"),
    true,
    "verify the operator-owned metadata canary Endpoints object",
  );
  for (const namespace of ["praetorium-system", CONTROL_PROBE_NAMESPACE, "traefik"]) {
    await review(attributes("list", "", "pods", namespace), true, `list Pods in ${namespace}`);
  }
  for (const namespace of ["praetorium-system", CONTROL_PROBE_NAMESPACE, ...runtimeNamespaces]) {
    for (const verb of ["get", "create", "delete"]) {
      await review(
        attributes(verb, "", "pods", namespace),
        true,
        `${verb} run-owned Pods in ${namespace}`,
      );
    }
  }

  for (const [attributesToDeny, description] of [
    [attributes("create", "", "namespaces"), "create namespaces"],
    [attributes("delete", "", "namespaces"), "delete namespaces"],
    [
      attributes("create", "rbac.authorization.k8s.io", "rolebindings", "praetorium-system"),
      "create system RoleBindings",
    ],
    [
      attributes("delete", "rbac.authorization.k8s.io", "rolebindings", "praetorium-system"),
      "delete system RoleBindings",
    ],
    [attributes("create", "", "secrets", "praetorium-system"), "create system Secrets"],
    [attributes("create", "apps", "deployments", "praetorium-system"), "create system Deployments"],
    [
      attributes("create", "rbac.authorization.k8s.io", "clusterrolebindings"),
      "create ClusterRoleBindings",
    ],
    [attributes("create", "rbac.authorization.k8s.io", "clusterroles"), "create ClusterRoles"],
    [
      attributes(
        "bind",
        "rbac.authorization.k8s.io",
        "clusterroles",
        undefined,
        "praetorium-provisioner-tenant-runtime",
      ),
      "bind the Provisioner tenant ClusterRole",
    ],
  ]) {
    await review(attributesToDeny, false, description);
  }
}

function assertAdmissionPolicyDenial(response, expected, description) {
  assert.equal(
    response.statusCode,
    422,
    `${description} must be denied by the active ValidatingAdmissionPolicy as HTTP 422 Invalid, got HTTP ${response.statusCode}`,
  );
  const body = response.body;
  assert.ok(isRecord(body), `${description} returned no Kubernetes Status response`);
  assert.equal(body.kind, "Status", `${description} did not return a Kubernetes Status response`);
  assert.equal(body.status, "Failure", `${description} did not return a failed API response`);
  assert.equal(body.reason, "Invalid", `${description} was not denied as Invalid`);
  assert.equal(body.code, 422, `${description} response code did not match HTTP 422`);
  assert.ok(typeof body.message === "string", `${description} denial omitted its message`);
  const { resource, group, resourceName, policyName, bindingName, validationMessage } = expected;
  const policyDenialMessage = `ValidatingAdmissionPolicy '${policyName}' with binding '${bindingName}' denied request: ${validationMessage}`;
  const resourceQualifiedName = group ? `${resource}.${group}` : resource;
  assert.ok(
    isRecord(body.details),
    `${description} omitted Kubernetes Status.details from its admission denial`,
  );
  assert.equal(
    body.details.kind,
    resource,
    `${description} reported an unexpected denied resource kind`,
  );
  assert.equal(
    body.details.group ?? "",
    group,
    `${description} reported an unexpected resource group`,
  );
  assert.equal(
    body.details.name,
    resourceName,
    `${description} reported an unexpected resource name`,
  );
  assert.equal(
    body.message,
    `${resourceQualifiedName} "${resourceName}" is forbidden: ${policyDenialMessage}`,
    `${description} did not use the expected resource-wrapped VAP denial`,
  );
  assert.ok(
    Array.isArray(body.details.causes) &&
      body.details.causes.some((cause) => cause.message === policyDenialMessage),
    `${description} did not include exact policy+binding+validation attribution in Status.details.causes`,
  );
}

async function requireNotFound(transport, requestPath, description, requestMs) {
  const response = await transport.request({
    method: "GET",
    path: requestPath,
    headers: { accept: "application/json" },
    signal: abortSignal(requestMs),
  });
  assert.equal(
    response.statusCode,
    404,
    `${description} unexpectedly exists or cannot be inspected`,
  );
  assert.equal(
    response.body?.kind,
    "Status",
    `${description} absence was not confirmed by a Kubernetes Status response`,
  );
  assert.equal(response.body?.reason, "NotFound", `${description} absence was not confirmed`);
}

async function verifyProvisionerAdmissionGuards(
  providerTransport,
  controllerTransport,
  run,
  requestMs,
) {
  const namespaceName = `praetorium-instances-t14-deny-${run}`;
  const roleBindingName = `t14-deny-${run}`;
  const namespacePath = `/api/v1/namespaces/${namespaceName}`;
  const roleBindingPath = `/api/v1/namespaces/praetorium-system/rolebindings/${roleBindingName}`;
  await requireNotFound(controllerTransport, namespacePath, "dry-run namespace", requestMs);
  await requireNotFound(controllerTransport, roleBindingPath, "dry-run RoleBinding", requestMs);

  const namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: namespaceName },
  };
  const namespaceResponse = await providerTransport.request({
    method: "POST",
    path: "/api/v1/namespaces?dryRun=All",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(namespace),
    signal: abortSignal(requestMs),
  });
  assertAdmissionPolicyDenial(
    namespaceResponse,
    {
      resource: "namespaces",
      group: "",
      resourceName: namespaceName,
      policyName: "praetorium-provisioner-instance-namespaces",
      bindingName: "praetorium-provisioner-instance-namespaces",
      validationMessage:
        "The Provisioner may create or update only a namespace owned by this cluster and one valid instance identity.",
    },
    "unowned run-unique Namespace server-side dry run",
  );
  await requireNotFound(controllerTransport, namespacePath, "dry-run namespace", requestMs);

  const roleBinding = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: { name: roleBindingName, namespace: "praetorium-system" },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "praetorium-provisioner-tenant-runtime",
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: "praetorium-provisioner",
        namespace: "praetorium-system",
      },
    ],
  };
  const roleBindingResponse = await providerTransport.request({
    method: "POST",
    path: "/api/v1/namespaces/praetorium-system/rolebindings?dryRun=All",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(roleBinding),
    signal: abortSignal(requestMs),
  });
  assertAdmissionPolicyDenial(
    roleBindingResponse,
    {
      resource: "rolebindings",
      group: "rbac.authorization.k8s.io",
      resourceName: roleBindingName,
      policyName: "praetorium-provisioner-instance-rolebindings",
      bindingName: "praetorium-provisioner-instance-rolebindings",
      validationMessage:
        "The Provisioner may change RoleBindings only inside a valid, owned per-instance namespace.",
    },
    "run-unique system RoleBinding server-side dry run with the exact tenant role and Provisioner subject",
  );
  await requireNotFound(controllerTransport, roleBindingPath, "dry-run RoleBinding", requestMs);
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
      validateNamespaceAndPodOwnership(current, run, inventoryId, {}, entry.namespace, entry.name);
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
  validateNamespaceAndPodOwnership(created, run, inventoryId, labels, namespace, name);
  const { pod, status } = await waitForPodTerminal(
    api,
    namespace,
    name,
    timeoutMs,
    config.timeouts.requestMs,
  );
  validateNamespaceAndPodOwnership(pod, run, inventoryId, labels, namespace, name);
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

function validateNamespaceAndPodOwnership(
  pod,
  run,
  inventoryId,
  expectedLabels,
  expectedNamespace,
  expectedName,
) {
  const metadata = metadataOf(pod);
  assert.equal(metadata.namespace, expectedNamespace, "probe Pod namespace changed");
  assert.equal(metadata.name, expectedName, "probe Pod name changed");
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
    validateNamespaceAndPodOwnership(current, run, inventoryId, {}, entry.namespace, entry.name);
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

function metadataPositiveControlScript(config) {
  const timeoutSeconds = Math.ceil(config.timeouts.networkProbeMs / 1000);
  const markerUrl = `http://169.254.169.254/.well-known/praetorium-t14/${config.metadataFixture.fixtureId}`;
  return [
    "set -eu",
    `response=$(curl --disable --noproxy '*' --fail --silent --show-error --connect-timeout 2 --max-time ${timeoutSeconds} --max-filesize 1024 --write-out 'HTTP:%{http_code}' "${markerUrl}")`,
    'expected="${T14_METADATA_MARKER}HTTP:200"',
    'if [ "$response" != "$expected" ]; then echo "metadata canary returned the wrong owned marker or status" >&2; exit 1; fi',
  ].join("\n");
}

async function runMetadataPositiveControl({
  api,
  controllerTransport,
  config,
  namespace,
  run,
  inventoryId,
  trackedPods,
}) {
  await verifyMetadataFixture(config, api, controllerTransport);
  const name = `metadata-control-${randomBytes(5).toString("hex")}`;
  const key = `${namespace}/${name}`;
  try {
    const result = await createAndRunPod({
      api,
      config,
      namespace,
      name,
      run,
      inventoryId,
      // Deliberately omit the tenant runtime selector labels so the rendered
      // runtime NetworkPolicy does not select this restricted positive control.
      labels: { [PROBE_APP_LABEL]: "metadata-positive-control" },
      script: metadataPositiveControlScript(config),
      env: [{ name: "T14_METADATA_MARKER", value: config.metadataFixture.marker }],
      timeoutMs: config.timeouts.readinessMs,
      trackedPods,
    });
    const nodeName = result.pod?.spec?.nodeName;
    assert.ok(
      typeof nodeName === "string" && nodeName.length > 0,
      "metadata control Pod has no live node",
    );
    return { nodeName };
  } finally {
    await cleanupPod(api, trackedPods, key, run, inventoryId, config.timeouts.requestMs);
  }
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
  const metadataUrl = `http://169.254.169.254/.well-known/praetorium-t14/${config.metadataFixture.fixtureId}`;
  return [
    "set -eu",
    `getent hosts "${peerHost}" >/dev/null`,
    `status=$(curl --disable --noproxy '*' --silent --show-error --connect-timeout 3 --max-time ${Math.ceil(config.timeouts.networkProbeMs / 1000)} --output /dev/null --write-out '%{http_code}' "http://${peerHost}:${peerPort}${APP_READY_PATH}" || true)`,
    "if [ \"$status\" != 000 ]; then echo 'cross-instance packet unexpectedly reached the peer' >&2; exit 1; fi",
    "getent hosts kubernetes.default.svc.cluster.local >/dev/null",
    `status=$(curl --disable --noproxy '*' --insecure --silent --show-error --connect-timeout 3 --max-time ${Math.ceil(config.timeouts.networkProbeMs / 1000)} --output /dev/null --write-out '%{http_code}' https://kubernetes.default.svc.cluster.local/version || true)`,
    "if [ \"$status\" != 000 ]; then echo 'tenant packet unexpectedly reached the Kubernetes control API' >&2; exit 1; fi",
    `status=$(curl --disable --noproxy '*' --silent --show-error --connect-timeout 3 --max-time ${Math.ceil(config.timeouts.networkProbeMs / 1000)} --output /dev/null --write-out '%{http_code}' "$T14_CONTROL_HEALTH_URL" || true)`,
    "if [ \"$status\" != 000 ]; then echo 'tenant packet unexpectedly reached the private Provisioner control endpoint' >&2; exit 1; fi",
    `status=$(curl --disable --noproxy '*' --silent --show-error --connect-timeout 2 --max-time ${Math.ceil(config.timeouts.networkProbeMs / 1000)} --output /dev/null --write-out '%{http_code}' "${metadataUrl}" || true)`,
    "if [ \"$status\" != 000 ]; then echo 'tenant packet unexpectedly reached link-local metadata' >&2; exit 1; fi",
    'getent hosts "$T14_PUBLIC_HOST" >/dev/null',
    `curl --disable --noproxy '*' --fail --silent --show-error --max-time ${Math.ceil(config.timeouts.networkProbeMs / 1000)} "$T14_PUBLIC_URL" | grep -Fqx "$T14_PUBLIC_MARKER"`,
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
  observerApi,
  controllerTransport,
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
  const metadataControl = await runMetadataPositiveControl({
    api,
    controllerTransport,
    config,
    namespace: sourceNamespace,
    run,
    inventoryId,
    trackedPods,
  });
  const nodes = await listAll(observerApi, "Node", "");
  const metadataControlNode = nodes.find(
    (node) => metadataOf(node).name === metadataControl.nodeName,
  );
  const hostnameLabel = metadataOf(metadataControlNode).labels?.["kubernetes.io/hostname"];
  assert.ok(
    typeof hostnameLabel === "string" && hostnameLabel.length > 0,
    "metadata positive-control node has no standard hostname label",
  );
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
    nodeSelector: { "kubernetes.io/hostname": hostnameLabel },
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
  const entry = {
    namespace: helperNamespace,
    name,
    uid: objectUid(created),
    resourceVersion: objectResourceVersion(created),
  };
  trackedPods.set(`${helperNamespace}/${name}`, entry);
  validateNamespaceAndPodOwnership(
    created,
    run,
    inventoryId,
    { [PROBE_APP_LABEL]: "unknown-capacity" },
    helperNamespace,
    name,
  );
  return { entry };
}

async function createUnboundWriter({ api, config, spec, run, inventoryId, trackedPods }) {
  const namespace = runtimeNamespace(config, spec.instanceId);
  const name = `unbound-${randomBytes(5).toString("hex")}`;
  const labels = tenantFixtureLabels(spec);
  const pod = podResource(name, namespace, run, inventoryId, config, "sleep 600", labels);
  delete pod.spec.nodeSelector;
  const created = await api.create(pod, abortSignal(config.timeouts.requestMs));
  const entry = {
    namespace,
    name,
    uid: objectUid(created),
    resourceVersion: objectResourceVersion(created),
  };
  trackedPods.set(`${namespace}/${name}`, entry);
  validateNamespaceAndPodOwnership(created, run, inventoryId, labels, namespace, name);
  const current = await api.get(
    { kind: "Pod", namespace, name },
    abortSignal(config.timeouts.requestMs),
  );
  validateNamespaceAndPodOwnership(current, run, inventoryId, labels, namespace, name);
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

async function runAcceptance({ inventory, config, credentialFiles, clusterOwnerMarker }) {
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
  await verifyControllerIdentityAndPermissions(
    controllerTransport,
    config.credentials.controllerIdentity,
    specs.map((spec) => runtimeNamespace(config, spec.instanceId)),
    config.timeouts.requestMs,
  );
  const guard = effectGuard(run, inventory, config, clusterOwnerMarker);
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
    const clusterProof = await preflightCluster(
      config,
      controllerApi,
      controllerTransport,
      runtime,
    );
    // These product-identity creates are server-side dry runs only. Requiring
    // them after exact metadata-canary object identity is verified makes
    // incomplete fixture input fail before the route probe or workload creation.
    await verifyProvisionerAdmissionGuards(
      providerTransport,
      controllerTransport,
      run,
      config.timeouts.requestMs,
    );
    await runMetadataPositiveControl({
      api: controllerApi,
      controllerTransport,
      config,
      namespace: "praetorium-system",
      run,
      inventoryId: inventory.inventoryId,
      trackedPods,
    });
    await preflightIngress(
      config,
      credentialFiles.ingressCa,
      `${run}.${config.network.hostnameSuffix}`,
    );
    await preflightPublicEgress(config);

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
    const controlBeforeA = await getLiveProvisionerHealthTarget(
      controllerApi,
      controllerTransport,
      clusterProof.provisionerDeploymentUid,
      config.timeouts.requestMs,
    );
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
      observerApi: providerApi,
      controllerTransport,
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
    const controlAfterA = await getLiveProvisionerHealthTarget(
      controllerApi,
      controllerTransport,
      clusterProof.provisionerDeploymentUid,
      config.timeouts.requestMs,
    );
    assert.equal(
      controlAfterA.uid,
      controlBeforeA.uid,
      "Provisioner Pod changed during the tenant private-endpoint denial probe",
    );
    assert.equal(controlAfterA.deploymentUid, controlBeforeA.deploymentUid);
    assert.equal(controlAfterA.replicaSetUid, controlBeforeA.replicaSetUid);
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
    const controlBeforeB = await getLiveProvisionerHealthTarget(
      controllerApi,
      controllerTransport,
      clusterProof.provisionerDeploymentUid,
      config.timeouts.requestMs,
    );
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
      observerApi: providerApi,
      controllerTransport,
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
    const controlAfterB = await getLiveProvisionerHealthTarget(
      controllerApi,
      controllerTransport,
      clusterProof.provisionerDeploymentUid,
      config.timeouts.requestMs,
    );
    assert.equal(
      controlAfterB.uid,
      controlBeforeB.uid,
      "Provisioner Pod changed during the tenant private-endpoint denial probe",
    );
    assert.equal(controlAfterB.deploymentUid, controlBeforeB.deploymentUid);
    assert.equal(controlAfterB.replicaSetUid, controlBeforeB.replicaSetUid);
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
        const current = await providerApi.getNamespace(namespace);
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
        await verifyRuntimeDeletion(providerApi, runtime, spec, config, guard);
        reservations.setStatus(spec.instanceId, "released");
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

test("Kubernetes identity and access reviews use their actual API resources", async () => {
  const requests = [];
  const transport = {
    async request(request) {
      requests.push(request);
      return { statusCode: 201, headers: {}, body: { kind: "Status", status: "Success" } };
    },
  };
  await selfReview(
    transport,
    "authentication.k8s.io/v1",
    { apiVersion: "authentication.k8s.io/v1", kind: "SelfSubjectReview", spec: {} },
    AbortSignal.timeout(1_000),
  );
  await selfReview(
    transport,
    "authorization.k8s.io/v1",
    {
      apiVersion: "authorization.k8s.io/v1",
      kind: "SelfSubjectAccessReview",
      spec: { resourceAttributes: { verb: "list", group: "", resource: "pods" } },
    },
    AbortSignal.timeout(1_000),
  );
  assert.deepEqual(
    requests.map(({ path }) => path),
    [
      "/apis/authentication.k8s.io/v1/selfsubjectreviews",
      "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
    ],
  );
});

test("T14 admission proof requires upstream-wrapped exact VAP and binding Invalid denial", () => {
  function makeVapStatus({
    resource,
    group,
    resourceName,
    policyName,
    bindingName,
    validationMessage,
    reason = "Invalid",
    code = 422,
  }) {
    const policyDenialMessage = `ValidatingAdmissionPolicy '${policyName}' with binding '${bindingName}' denied request: ${validationMessage}`;
    const resourceQualifiedName = group ? `${resource}.${group}` : resource;
    return {
      statusCode: code,
      body: {
        kind: "Status",
        apiVersion: "v1",
        metadata: {},
        status: "Failure",
        message: `${resourceQualifiedName} "${resourceName}" is forbidden: ${policyDenialMessage}`,
        reason,
        details: {
          kind: resource,
          ...(group ? { group } : {}),
          name: resourceName,
          causes: [{ message: policyDenialMessage }],
        },
        code,
      },
    };
  }

  const namespaceExpected = {
    resource: "namespaces",
    group: "",
    resourceName: "praetorium-instances-t14-deny-0123456789abcdef0123",
    policyName: "praetorium-provisioner-instance-namespaces",
    bindingName: "praetorium-provisioner-instance-namespaces",
    validationMessage:
      "The Provisioner may create or update only a namespace owned by this cluster and one valid instance identity.",
  };
  const roleBindingExpected = {
    resource: "rolebindings",
    group: "rbac.authorization.k8s.io",
    resourceName: "t14-deny-0123456789abcdef0123",
    policyName: "praetorium-provisioner-instance-rolebindings",
    bindingName: "praetorium-provisioner-instance-rolebindings",
    validationMessage:
      "The Provisioner may change RoleBindings only inside a valid, owned per-instance namespace.",
  };

  assert.doesNotThrow(() =>
    assertAdmissionPolicyDenial(
      makeVapStatus(namespaceExpected),
      namespaceExpected,
      "test Namespace request",
    ),
  );
  assert.doesNotThrow(() =>
    assertAdmissionPolicyDenial(
      makeVapStatus(roleBindingExpected),
      roleBindingExpected,
      "test system RoleBinding request",
    ),
  );

  const genericRbacForbidden = makeVapStatus(namespaceExpected);
  genericRbacForbidden.statusCode = 403;
  genericRbacForbidden.body.status = "Failure";
  genericRbacForbidden.body.reason = "Forbidden";
  genericRbacForbidden.body.code = 403;
  genericRbacForbidden.body.message = `namespaces "${namespaceExpected.resourceName}" is forbidden: User "system:serviceaccount:default:default" cannot create namespaces`;
  genericRbacForbidden.body.details = {
    kind: "namespaces",
    name: namespaceExpected.resourceName,
  };
  assert.throws(
    () =>
      assertAdmissionPolicyDenial(
        genericRbacForbidden,
        namespaceExpected,
        "test Namespace request",
      ),
    /HTTP 422 Invalid/u,
    "generic RBAC Forbidden must not count as proof that the VAP is enforcing",
  );

  const bindinglessDenial = makeVapStatus(namespaceExpected);
  const withoutBinding = `ValidatingAdmissionPolicy '${namespaceExpected.policyName}' denied request: ${namespaceExpected.validationMessage}`;
  bindinglessDenial.body.message = `namespaces "${namespaceExpected.resourceName}" is forbidden: ${withoutBinding}`;
  bindinglessDenial.body.details.causes = [{ message: withoutBinding }];
  assert.throws(
    () =>
      assertAdmissionPolicyDenial(bindinglessDenial, namespaceExpected, "test Namespace request"),
    /expected resource-wrapped VAP denial/u,
    "a policy name without exact binding attribution must fail",
  );

  const configurationFailure = makeVapStatus(namespaceExpected);
  const failedConfiguration = `ValidatingAdmissionPolicy '${namespaceExpected.policyName}' with binding '${namespaceExpected.bindingName}' denied request: failed to configure binding: CEL error`;
  configurationFailure.body.message = `namespaces "${namespaceExpected.resourceName}" is forbidden: ${failedConfiguration}`;
  configurationFailure.body.details.causes = [{ message: failedConfiguration }];
  assert.throws(
    () =>
      assertAdmissionPolicyDenial(
        configurationFailure,
        namespaceExpected,
        "test Namespace request",
      ),
    /expected resource-wrapped VAP denial/u,
    "policy configuration/evaluation failures must not count as an enforced validation",
  );
});

test("T14 private health target follows the live Deployment, ReplicaSet and ServiceAccount", async () => {
  const deployment = {
    kind: "Deployment",
    metadata: {
      name: "praetorium-provisioner",
      namespace: "praetorium-system",
      uid: "deployment-uid",
    },
    spec: {
      selector: { matchLabels: { [APP_LABEL]: "provisioner" } },
      template: { spec: { serviceAccountName: "praetorium-provisioner" } },
    },
  };
  const replicaSet = {
    kind: "ReplicaSet",
    metadata: {
      name: "praetorium-provisioner-1234567890",
      namespace: "praetorium-system",
      uid: "replicaset-uid",
      ownerReferences: [
        {
          kind: "Deployment",
          name: "praetorium-provisioner",
          uid: "deployment-uid",
          controller: true,
        },
      ],
    },
    spec: { template: { spec: { serviceAccountName: "praetorium-provisioner" } } },
  };
  const pod = {
    kind: "Pod",
    metadata: {
      name: "praetorium-provisioner-1234567890-abcde",
      namespace: "praetorium-system",
      uid: "pod-uid",
      labels: { [APP_LABEL]: "provisioner" },
      ownerReferences: [
        {
          kind: "ReplicaSet",
          name: replicaSet.metadata.name,
          uid: "replicaset-uid",
          controller: true,
        },
      ],
    },
    spec: { serviceAccountName: "praetorium-provisioner" },
    status: {
      phase: "Running",
      podIP: "10.96.0.7",
      containerStatuses: [{ name: "provisioner", state: { running: {} } }],
    },
  };
  const controllerApi = {
    async get(reference) {
      assert.deepEqual(reference, {
        kind: "Deployment",
        namespace: "praetorium-system",
        name: "praetorium-provisioner",
      });
      return deployment;
    },
    async list(kind, namespace, labelSelector) {
      assert.equal(kind, "Pod");
      assert.equal(namespace, "praetorium-system");
      assert.equal(labelSelector, `${APP_LABEL}=provisioner`);
      return { items: [pod] };
    },
  };
  const controllerTransport = {
    async request(request) {
      assert.equal(request.method, "GET");
      assert.match(request.path, /\/apis\/apps\/v1\/namespaces\/praetorium-system\/replicasets\?/u);
      return {
        statusCode: 200,
        body: { kind: "ReplicaSetList", metadata: {}, items: [replicaSet] },
      };
    },
  };

  const target = await getLiveProvisionerHealthTarget(
    controllerApi,
    controllerTransport,
    "deployment-uid",
    1_000,
  );
  assert.deepEqual(target, {
    uid: "pod-uid",
    deploymentUid: "deployment-uid",
    replicaSetUid: "replicaset-uid",
    url: "http://10.96.0.7:8080/healthz",
  });

  pod.metadata.ownerReferences = [];
  await assert.rejects(
    getLiveProvisionerHealthTarget(controllerApi, controllerTransport, "deployment-uid", 1_000),
    /actual Provisioner Deployment has no running Pod owned through its ReplicaSet/u,
  );
});

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
      controllerIdentity: "system:serviceaccount:t14-test:t14-controller",
      controllerTokenPath: "/tmp/t14-private/controller-token",
      providerTokenPath: "/tmp/t14-private/provisioner-token",
      caPath: "/tmp/t14-private/ca.crt",
    },
    metadataFixture: {
      inventoryId: inventory.inventoryId,
      ownerIdentity: inventory.owner.identity,
      environmentName: inventory.environment.name,
      expiresAt: inventory.environment.expiresAt,
      fixtureId: "a".repeat(32),
      marker: `t14-metadata-${"b".repeat(64)}`,
      routeAttestation: `t14-owned-route:${inventory.inventoryId}:${"a".repeat(32)}`,
      serviceName: `t14-meta-s-${"a".repeat(20)}`,
      serviceUid: "11111111-1111-4111-8111-111111111111",
      endpointsUid: "22222222-2222-4222-8222-222222222222",
      podName: `t14-meta-p-${"a".repeat(20)}`,
      podUid: "33333333-3333-4333-8333-333333333333",
      podIp: "10.244.0.2",
      imageRef: `ghcr.io/praetorium/t14-metadata-canary@sha256:${"c".repeat(64)}`,
      imageDigest: `sha256:${"c".repeat(64)}`,
      platformManifestDigest: `sha256:${"d".repeat(64)}`,
      resources: { cpuMilli: 100, memoryMiB: 64, ephemeralStorageMiB: 128 },
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
  const ownedClusterName = "praetorium-owned-kube-fresh-20261017";
  const ownedCluster = {
    ...valid,
    cluster: {
      ...valid.cluster,
      name: ownedClusterName,
      context: `kind-${ownedClusterName}`,
      confirmation: ownedClusterName,
      ownerMarkerPath: "/tmp/t14-private/kind-owner.json",
    },
  };
  assert.deepEqual(
    validateConfig(ownedCluster, inventory, now),
    [],
    "the existing owner-marked fresh Kind cluster must satisfy the fixed runner's exact context contract",
  );
  assert.ok(
    validateConfig(
      {
        ...ownedCluster,
        cluster: Object.fromEntries(
          Object.entries(ownedCluster.cluster).filter(([key]) => key !== "ownerMarkerPath"),
        ),
      },
      inventory,
      now,
    ).some((error) => error.includes("ownerMarkerPath")),
    "an existing owned-cluster name must carry its owner marker path",
  );
  assert.ok(
    validateConfig(
      {
        ...ownedCluster,
        cluster: { ...ownedCluster.cluster, context: "kind-another-cluster" },
      },
      inventory,
      now,
    ).some((error) => error.includes("exact Kind context")),
    "the existing cluster prefix must not bypass exact Kind context validation",
  );
  assert.ok(
    validateConfig(
      {
        ...ownedCluster,
        cluster: {
          ...ownedCluster.cluster,
          name: "praetorium-owned-kube-other-20261017",
          context: "kind-praetorium-owned-kube-other-20261017",
          confirmation: "praetorium-owned-kube-other-20261017",
        },
      },
      inventory,
      now,
    ).some((error) => error.includes("explicitly disposable T14 Kind cluster")),
    "only the specifically owner-marked fresh cluster family is permitted",
  );
  const clusterOwnerMarker = {
    schema: "praetorium.local-kind-owner/v1",
    owner: "test operator",
    uid: typeof process.getuid === "function" ? process.getuid() : 1000,
    purpose: "fresh canonical disposable Kind verification",
    createdAt: "2026-09-30T00:00:00Z",
    clusterName: ownedClusterName,
    clusterId: ownedCluster.cluster.id,
    context: ownedCluster.cluster.context,
    apiHost: ownedCluster.cluster.apiHost,
    apiPort: ownedCluster.cluster.apiPort,
    disposable: true,
    production: false,
    expiresAt: "2026-10-03T00:00:00Z",
  };
  assert.deepEqual(validateClusterOwnerMarker(clusterOwnerMarker, ownedCluster, now), []);
  assert.ok(
    validateClusterOwnerMarker(
      { ...clusterOwnerMarker, clusterId: "clu_00000000000000000000000002" },
      ownedCluster,
      now,
    ).some((error) => error.includes("cluster ID must match")),
    "the owner marker must bind the exact cluster ID as well as its name",
  );
  assert.ok(
    validateClusterOwnerMarker(
      { ...clusterOwnerMarker, context: "kind-another-cluster" },
      ownedCluster,
      now,
    ).some((error) => error.includes("context must match")),
  );
  assert.ok(
    validateClusterOwnerMarker({ ...clusterOwnerMarker, production: true }, ownedCluster, now).some(
      (error) => error.includes("must be nonproduction"),
    ),
  );
  assert.doesNotThrow(() =>
    assertClusterNodeOwnership(
      [
        {
          metadata: {
            labels: {
              "praetorium.io/cluster-id": ownedCluster.cluster.id,
              "praetorium.io/disposable": "true",
            },
          },
        },
      ],
      ownedCluster.cluster.id,
    ),
  );
  assert.throws(
    () =>
      assertClusterNodeOwnership(
        [
          {
            metadata: {
              labels: {
                "praetorium.io/cluster-id": "clu_00000000000000000000000002",
                "praetorium.io/disposable": "true",
              },
            },
          },
        ],
        ownedCluster.cluster.id,
      ),
    /cluster ID does not match/u,
  );
  const renderedSpec = runtimeSpec(valid, `ins_${"0".repeat(26)}`, valid.network.hostnameSuffix);
  const renderedService = makeRenderer(valid)
    .renderRunning(renderedSpec)
    .find((resource) => resource.kind === "Service");
  assert.ok(renderedService, "production renderer did not emit the runtime Service");
  assert.equal(
    runtimeNamespace(valid, renderedSpec.instanceId),
    renderedService.metadata.namespace,
    "runner namespace must match the namespace rendered by the production provider",
  );
  assert.equal(
    runtimeService(renderedSpec.instanceId),
    renderedService.metadata.name,
    "runner Service name must match the production provider renderer",
  );
  assert.ok(
    validRunNamespace(
      runtimeNamespace(valid, renderedSpec.instanceId),
      valid.cluster.namespacePrefix,
    ),
    "a production-rendered runtime namespace must satisfy the runner's namespace gate",
  );
  assert.ok(
    validateConfig(
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "metadataFixture")),
      inventory,
      now,
    ).some((error) => error.includes("config.metadataFixture must be an object")),
    "metadata route fixture must be present before any Kubernetes or network probe",
  );
  assert.ok(
    validateConfig(
      {
        ...valid,
        metadataFixture: {
          ...valid.metadataFixture,
          routeAttestation: "t14-owned-route:another-inventory:another-fixture",
        },
      },
      inventory,
      now,
    ).some((error) => error.includes("routeAttestation must explicitly attest")),
    "metadata route attestation must bind to this inventory and unique fixture ID",
  );
  assert.ok(
    validateConfig(
      {
        ...valid,
        metadataFixture: {
          ...valid.metadataFixture,
          serviceName: "shared-metadata-service",
        },
      },
      inventory,
      now,
    ).some((error) => error.includes("serviceName must be the unique derived")),
    "metadata service must have its inventory-specific derived name",
  );
  assert.ok(
    validateConfig(
      {
        ...valid,
        credentials: { ...valid.credentials, controllerIdentity: "system:masters\n" },
      },
      inventory,
      now,
    ).some((error) => error.includes("explicit Kubernetes username")),
  );
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
