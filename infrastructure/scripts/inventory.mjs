import { readFileSync } from "node:fs";
import path from "node:path";
import { validateSystemNetwork } from "./system-network.mjs";

export const requiredIntegrationCategories = [
  "workers-d1-do",
  "github-access",
  "buildkit-registry",
  "kubernetes-isolation",
  "browser-entry",
  "producer-recovery",
  "stable-rollout",
];

const inventoryKeys = [
  "apiVersion",
  "environment",
  "ownership",
  "clusterId",
  "cloudflare",
  "domains",
  "network",
  "gateway",
  "buildkit",
  "buildWorker",
  "workNotifications",
  "buildPolicy",
  "releasePolicy",
  "images",
  "secretRefs",
  "acmeContactEmail",
];

const imageKeys = ["provisioner", "instanceAccess", "buildWorker", "prometheus"];
const builderKeyKeys = ["keyId", "publicKeyBase64", "revoked", "validFrom", "validUntil"];
const signerIdentityKeys = ["subjectAlternativeName", "issuer"];
const secretKeys = [
  "controlPlaneCredential",
  "instanceAccessServiceAuth",
  "buildWorkerControlPlaneAuth",
  "buildWorkerSigningKey",
  "buildWorkerRegistryPush",
  "buildWorkerRegistryPull",
  "applicationImagePull",
  "cloudflareDnsApiToken",
  "buildkitClient",
];
const workNotificationSecretKeys = [
  "provisionerWorkNotificationToken",
  "buildWorkerWorkNotificationToken",
];
const productionCloudflareResources = Object.freeze({
  controlPlaneWorker: "praetorium-control-plane",
  gatewayWorker: "praetorium-gateway",
  controlPlaneDatabaseName: "praetorium-platform",
  controlPlaneDatabaseId: "08f29fef-eb9e-4541-82fb-777fa2f4aab0",
  gatewayKvNamespaceId: "770c4ac60df74b019409c1203f35687d",
});

function exactKeys(value, expected, name, errors, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${name} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const required = wanted.filter((key) => !optional.includes(key));
  if (
    actual.some((key) => !wanted.includes(key)) ||
    required.some((key) => !actual.includes(key))
  ) {
    const details = optional.length ? `; optional: ${optional.join(", ")}` : "";
    errors.push(`${name} must contain exactly: ${required.join(", ")}${details}`);
  }
  return true;
}

function requiredString(value, name, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${name} must be a non-empty string`);
    return false;
  }
  if (/\{\{|\}\}|<[^>]+>|\b(?:REPLACE|CHANGEME|TODO|PLACEHOLDER)\b/i.test(value)) {
    errors.push(`${name} contains a placeholder`);
  }
  return true;
}

function dnsSuffix(value) {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

function utcDateTime(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  ) {
    return false;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}

function reservedHostname(value) {
  return /(^|\.)(localhost|test|invalid|example)$|(^|\.)example\.(com|net|org)$/i.test(value);
}

function reservedRepositoryPath(value) {
  return /(^|\/)(example|placeholder|replace|changeme|todo|sample|dummy|test)(\/|$)/i.test(value);
}

function validateSecretRef(value, name, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${name} must contain secret locators only`);
    return;
  }
  const allowed = name.endsWith(".buildkitClient")
    ? ["name", "caKey", "certKey", "privateKey"]
    : ["name", "key"];
  exactKeys(value, allowed, name, errors);
  for (const field of allowed) requiredString(value[field], `${name}.${field}`, errors);
  if (typeof value.name === "string" && !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(value.name)) {
    errors.push(`${name}.name must be a Kubernetes DNS subdomain`);
  }
  for (const field of allowed.filter((key) => key !== "name")) {
    if (typeof value[field] === "string" && !/^[A-Za-z0-9._-]+$/.test(value[field])) {
      errors.push(`${name}.${field} must be a safe Kubernetes secret data key`);
    }
  }
  for (const field of Object.keys(value)) {
    if (/value|token|password|secret|credential/i.test(field) && field !== "name") {
      errors.push(`${name}.${field} must be a key name, never a secret value`);
    }
  }
}

export function validateInventory(value) {
  const errors = [];
  const blockers = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("inventory must be an object");
    value = {};
  }
  exactKeys(value, inventoryKeys, "inventory", errors, ["workNotifications"]);
  if (value.apiVersion !== "praetorium.io/deployment-inventory/v1") {
    errors.push("apiVersion must be praetorium.io/deployment-inventory/v1");
  }
  if (value.environment !== "disposable-test" && value.environment !== "deployment") {
    errors.push("environment must be disposable-test or deployment");
  }

  exactKeys(
    value.ownership,
    ["provider", "clusterName", "context", "disposable", "confirmation"],
    "ownership",
    errors,
  );
  if (!["kind", "k3s"].includes(value.ownership?.provider)) {
    errors.push("ownership.provider must be kind or k3s");
  }
  requiredString(value.ownership?.clusterName, "ownership.clusterName", errors);
  requiredString(value.ownership?.context, "ownership.context", errors);
  if (value.ownership?.confirmation !== value.ownership?.clusterName) {
    errors.push("ownership.confirmation must repeat the explicit cluster name");
  }
  if (value.ownership?.provider === "kind") {
    if (value.environment !== "disposable-test" || value.ownership.disposable !== true) {
      errors.push("Kind ownership requires a disposable-test inventory");
    }
    if (value.ownership.context !== `kind-${value.ownership.clusterName}`) {
      errors.push("ownership.context must be the Kind context for ownership.clusterName");
    }
  } else if (value.ownership?.provider === "k3s") {
    if (value.environment !== "deployment" || value.ownership.disposable !== false) {
      errors.push("K3s ownership requires a non-disposable deployment inventory");
    }
    if (value.ownership.context === `kind-${value.ownership.clusterName}`) {
      errors.push("K3s context cannot be a Kind context");
    }
  }

  requiredString(value.clusterId, "clusterId", errors);
  if (!/^clu_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.clusterId ?? "")) {
    errors.push("clusterId must be an opaque cluster identifier");
  }

  exactKeys(
    value.cloudflare,
    ["mode", "accountId", "controlPlaneDatabaseId", "gatewayKvNamespaceId"],
    "cloudflare",
    errors,
  );
  if (!["local", "remote-disposable", "remote"].includes(value.cloudflare?.mode)) {
    errors.push("cloudflare.mode must be local, remote-disposable or remote");
  }
  if (value.cloudflare?.mode === "local") {
    if (value.cloudflare.accountId !== null)
      errors.push("local Cloudflare mode must not include an accountId");
    if (
      !/^00000000-0000-0000-0000-[0-9]{12}$/.test(value.cloudflare?.controlPlaneDatabaseId ?? "")
    ) {
      errors.push("local Cloudflare mode requires a local-only controlPlaneDatabaseId");
    }
    if (value.cloudflare?.gatewayKvNamespaceId !== "00000000000000000000000000000000") {
      errors.push("local Cloudflare mode requires the local-only gatewayKvNamespaceId");
    }
  } else {
    requiredString(value.cloudflare?.accountId, "cloudflare.accountId", errors);
    if (
      !/^[a-f0-9]{32}$/.test(value.cloudflare?.accountId ?? "") ||
      value.cloudflare?.accountId === "00000000000000000000000000000000"
    ) {
      errors.push("cloudflare.accountId must be a 32-character account ID");
    }
    requiredString(
      value.cloudflare?.controlPlaneDatabaseId,
      "cloudflare.controlPlaneDatabaseId",
      errors,
    );
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        value.cloudflare?.controlPlaneDatabaseId ?? "",
      ) ||
      /^00000000-0000-0000-0000-[0-9]{12}$/.test(value.cloudflare?.controlPlaneDatabaseId ?? "")
    ) {
      errors.push(
        "cloudflare.controlPlaneDatabaseId must be a real non-placeholder D1 database ID",
      );
    }
    requiredString(
      value.cloudflare?.gatewayKvNamespaceId,
      "cloudflare.gatewayKvNamespaceId",
      errors,
    );
    if (
      !/^[a-f0-9]{32}$/.test(value.cloudflare?.gatewayKvNamespaceId ?? "") ||
      value.cloudflare?.gatewayKvNamespaceId === "00000000000000000000000000000000"
    ) {
      errors.push("cloudflare.gatewayKvNamespaceId must be a real non-placeholder KV namespace ID");
    }
  }

  exactKeys(
    value.domains,
    [
      "gatewayOrigin",
      "gatewayServiceUrl",
      "controlPlaneUrl",
      "instanceHostnameSuffix",
      "tlsSecretName",
    ],
    "domains",
    errors,
  );
  for (const field of ["gatewayOrigin", "controlPlaneUrl", "gatewayServiceUrl"]) {
    const raw = value.domains?.[field];
    if (raw === null && field === "gatewayOrigin") {
      blockers.push("HTTPS Gateway origin has not been supplied");
      continue;
    }
    if (raw === null && field === "controlPlaneUrl") {
      blockers.push(
        "HTTPS Control Plane URL reachable from the Provisioner pod has not been supplied",
      );
      continue;
    }
    if (raw === null && field === "gatewayServiceUrl") {
      blockers.push(
        "Gateway service URL reachable from the Node Instance Access pod has not been supplied",
      );
      continue;
    }
    requiredString(raw, `domains.${field}`, errors);
    try {
      const url = new URL(raw);
      const local = value.environment === "disposable-test";
      const allowedProtocols =
        field === "gatewayOrigin" || field === "controlPlaneUrl"
          ? ["https:"]
          : local
            ? ["http:", "https:"]
            : ["https:"];
      if (!allowedProtocols.includes(url.protocol))
        errors.push(`domains.${field} must use ${allowedProtocols.join(" or ")}`);
      if (url.username || url.password || url.hash || url.search || url.pathname !== "/") {
        errors.push(
          `domains.${field} must be an origin without credentials, path, query, or fragment`,
        );
      }
      if (!local && reservedHostname(url.hostname)) {
        errors.push(`domains.${field} uses a reserved test or placeholder hostname`);
      }
    } catch {
      errors.push(`domains.${field} must be a valid URL`);
    }
  }
  if (!dnsSuffix(value.domains?.instanceHostnameSuffix)) {
    errors.push("domains.instanceHostnameSuffix must be a lowercase DNS suffix");
  }
  if (
    value.environment !== "disposable-test" &&
    reservedHostname(value.domains?.instanceHostnameSuffix ?? "")
  ) {
    errors.push("domains.instanceHostnameSuffix uses a reserved test or placeholder suffix");
  }
  requiredString(value.domains?.tlsSecretName, "domains.tlsSecretName", errors);
  if (
    typeof value.domains?.tlsSecretName === "string" &&
    !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(value.domains.tlsSecretName)
  ) {
    errors.push("domains.tlsSecretName must be a Kubernetes DNS subdomain");
  }

  const systemNetwork = validateSystemNetwork(value.network, value.domains);
  errors.push(...systemNetwork.errors);
  blockers.push(...systemNetwork.blockers);

  exactKeys(
    value.gateway,
    ["allowedRepositoryOwner", "githubAppId", "githubOauthClientId", "tokenEncryptionKeyId",
      "adminOrigin", "adminGithubUserIds", "releaseSources", "adminObserverVpcServiceId"],
    "gateway",
    errors,
    ["adminOrigin", "adminGithubUserIds", "releaseSources", "adminObserverVpcServiceId"],
  );
  for (const field of [
    "allowedRepositoryOwner",
    "githubAppId",
    "githubOauthClientId",
    "tokenEncryptionKeyId",
  ]) {
    if (value.gateway?.[field] === null) {
      blockers.push(`Gateway ${field} has not been supplied`);
      continue;
    }
    if (field === "githubAppId") {
      if (!Number.isSafeInteger(value.gateway?.githubAppId) || value.gateway.githubAppId < 1) {
        errors.push("gateway.githubAppId must be a positive safe integer or null");
      }
    } else {
      requiredString(value.gateway?.[field], `gateway.${field}`, errors);
    }
  }
  if (
    typeof value.gateway?.allowedRepositoryOwner === "string" &&
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value.gateway.allowedRepositoryOwner)
  ) {
    errors.push("gateway.allowedRepositoryOwner must be a GitHub owner name");
  }
  if (
    typeof value.gateway?.githubOauthClientId === "string" &&
    (value.gateway.githubOauthClientId.length > 256 ||
      /placeholder|example/i.test(value.gateway.githubOauthClientId))
  ) {
    errors.push("gateway.githubOauthClientId must be a configured OAuth client ID");
  }
  if (
    typeof value.gateway?.tokenEncryptionKeyId === "string" &&
    !/^[A-Za-z0-9_-]{1,64}$/.test(value.gateway.tokenEncryptionKeyId)
  ) {
    errors.push("gateway.tokenEncryptionKeyId must be a safe key identifier");
  }

  if (value.gateway?.adminObserverVpcServiceId !== undefined &&
      value.gateway.adminObserverVpcServiceId !== null &&
      (typeof value.gateway.adminObserverVpcServiceId !== "string" ||
       !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value.gateway.adminObserverVpcServiceId))) {
    errors.push("gateway.adminObserverVpcServiceId must be a valid dedicated VPC service ID");
  }
  const adminOrigin = value.gateway?.adminOrigin ?? null;
  const adminIds = value.gateway?.adminGithubUserIds ?? [];
  const releaseSources = value.gateway?.releaseSources ?? [];
  if (!Array.isArray(adminIds) || adminIds.length > 32 ||
      adminIds.some(id => !Number.isSafeInteger(id) || id < 1) ||
      new Set(adminIds).size !== adminIds.length)
    errors.push("gateway.adminGithubUserIds must contain unique positive safe integers (maximum 32)");
  if (!Array.isArray(releaseSources) || releaseSources.length > 8) {
    errors.push("gateway.releaseSources must be an array (maximum 8)");
  } else {
    for (const source of releaseSources) {
      exactKeys(source, ["id", "label", "githubRepository", "adapter"], "gateway.releaseSources[]", errors);
      if (source?.id !== "scriptorium" || source?.githubRepository !== "yohn-jp/scriptorium" ||
          source?.adapter !== "scriptorium-v1" || typeof source?.label !== "string" ||
          source.label.length < 1 || source.label.length > 64)
        errors.push("gateway.releaseSources must use the approved Scriptorium identity and adapter");
    }
    if (new Set(releaseSources.map(source => source?.id)).size !== releaseSources.length)
      errors.push("gateway.releaseSources must have unique identities");
  }
  if (adminOrigin !== null) {
    try {
      const url = new URL(adminOrigin);
      if (url.origin !== adminOrigin || url.protocol !== "https:" || url.username || url.password ||
          adminOrigin === value.domains?.gatewayOrigin)
        errors.push("gateway.adminOrigin must be a distinct exact HTTPS origin");
    } catch { errors.push("gateway.adminOrigin must be an exact HTTPS origin or null"); }
  }
  if (adminOrigin !== null || adminIds.length || releaseSources.length) {
    if (!adminOrigin || !Array.isArray(adminIds) || adminIds.length === 0)
      errors.push("Gateway Admin features require both adminOrigin and adminGithubUserIds");
    if (releaseSources.length && !value.releasePolicy)
      errors.push("Gateway Source features require releasePolicy");
  }

  exactKeys(
    value.buildkit,
    ["endpoint", "tlsSecretName", "allowedClientCidrs", "frontendRepository", "outputRepository"],
    "buildkit",
    errors,
  );
  if (value.buildkit?.endpoint !== null) {
    requiredString(value.buildkit?.endpoint, "buildkit.endpoint", errors);
    if (!/^tcp:\/\/[a-z0-9.-]+:[0-9]{1,5}$/.test(value.buildkit?.endpoint ?? "")) {
      errors.push("buildkit.endpoint must be tcp://host:port or null");
    } else if (
      value.environment !== "disposable-test" &&
      reservedHostname(value.buildkit.endpoint.slice("tcp://".length).replace(/:[0-9]+$/, ""))
    ) {
      errors.push("buildkit.endpoint must not use a reserved test or placeholder hostname");
    }
  } else {
    blockers.push("BuildKit mTLS endpoint has not been supplied");
  }
  requiredString(value.buildkit?.tlsSecretName, "buildkit.tlsSecretName", errors);
  if (value.buildkit?.tlsSecretName !== value.secretRefs?.buildkitClient?.name) {
    errors.push("buildkit.tlsSecretName must match secretRefs.buildkitClient.name");
  }
  if (!Array.isArray(value.buildkit?.allowedClientCidrs)) {
    errors.push("buildkit.allowedClientCidrs must be an array of explicit client CIDRs");
  } else if (value.buildkit.allowedClientCidrs.length === 0) {
    blockers.push("BuildKit worker-only client CIDRs have not been supplied");
  } else {
    for (const [index, cidr] of value.buildkit.allowedClientCidrs.entries()) {
      requiredString(cidr, `buildkit.allowedClientCidrs[${index}]`, errors);
      const parsed = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/([0-9]|[12][0-9]|3[0-2])$/.exec(
        cidr,
      );
      if (
        !parsed ||
        parsed.slice(1, 5).some((octet) => Number(octet) > 255) ||
        parsed?.[5] === "0"
      ) {
        errors.push(`buildkit.allowedClientCidrs[${index}] must be an IPv4 CIDR`);
      }
    }
  }

  for (const field of ["frontendRepository", "outputRepository"]) {
    const repository = value.buildkit?.[field];
    if (repository === null) {
      blockers.push(`BuildKit ${field} has not been supplied`);
      continue;
    }
    requiredString(repository, `buildkit.${field}`, errors);
    if (
      typeof repository === "string" &&
      (!/^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(
        repository,
      ) ||
        reservedRepositoryPath(repository))
    ) {
      errors.push(`buildkit.${field} must be a real GHCR repository path`);
    }
  }

  exactKeys(
    value.buildWorker,
    ["signingKeyId", "compositionRepository", "buildctlPath"],
    "buildWorker",
    errors,
  );
  for (const field of ["signingKeyId", "compositionRepository", "buildctlPath"]) {
    if (value.buildWorker?.[field] === null) {
      blockers.push(`Build Worker ${field} has not been supplied`);
    } else {
      requiredString(value.buildWorker?.[field], `buildWorker.${field}`, errors);
    }
  }
  if (
    typeof value.buildWorker?.signingKeyId === "string" &&
    (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(value.buildWorker.signingKeyId) ||
      /^(?:example|placeholder|replace|changeme|todo|sample|dummy|test)(?:$|[^a-z0-9])/i.test(
        value.buildWorker.signingKeyId,
      ))
  ) {
    errors.push("buildWorker.signingKeyId must be a safe public key identifier");
  }
  if (
    typeof value.buildWorker?.compositionRepository === "string" &&
    (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(
      value.buildWorker.compositionRepository,
    ) ||
      reservedRepositoryPath(value.buildWorker.compositionRepository))
  ) {
    errors.push("buildWorker.compositionRepository must be a real owner/repository path");
  }
  if (
    typeof value.buildWorker?.buildctlPath === "string" &&
    (!value.buildWorker.buildctlPath.startsWith("/") ||
      value.buildWorker.buildctlPath.split("/").includes(".."))
  ) {
    errors.push("buildWorker.buildctlPath must be an absolute path without parent traversal");
  }

  const workNotificationsEnabled = value.workNotifications?.enabled === true;
  if (Object.hasOwn(value, "workNotifications")) {
    exactKeys(value.workNotifications, ["enabled", "coordinationVpcServiceId"], "workNotifications", errors, ["coordinationVpcServiceId"]);
    if (typeof value.workNotifications?.enabled !== "boolean") {
      errors.push("workNotifications.enabled must be boolean");
    }
    if (Object.hasOwn(value.workNotifications ?? {}, "coordinationVpcServiceId")) {
      if (!workNotificationsEnabled ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.workNotifications.coordinationVpcServiceId ?? "")) {
        errors.push("workNotifications.coordinationVpcServiceId requires enabled notifications and a provisioned UUID");
      }
    }
  }
  // The production Coordination transport is provisioned. A partial inventory
  // must not silently remove its binding on the next Worker deployment.
  if (
    value.environment === "deployment" &&
    (!workNotificationsEnabled || !value.workNotifications?.coordinationVpcServiceId)
  ) {
    blockers.push("deployment requires enabled workNotifications with coordinationVpcServiceId");
  }

  exactKeys(
    value.buildPolicy,
    [
      "registryUrl",
      "maxImageLayerBytes",
      "maxImageVerificationMs",
      "maxRegistryRequestMs",
      "targetPlatform",
      "runtimeResourceLimits",
      "cacheRetention",
      "builderKeys",
    ],
    "buildPolicy",
    errors,
  );
  if (value.buildPolicy?.registryUrl !== "https://ghcr.io") {
    errors.push("buildPolicy.registryUrl must be the configured HTTPS GHCR origin");
  }
  for (const [field, minimum, maximum] of [
    ["maxImageLayerBytes", 1, 16 * 1024 ** 3],
    ["maxImageVerificationMs", 1_000, 120_000],
    ["maxRegistryRequestMs", 100, 60_000],
  ]) {
    const amount = value.buildPolicy?.[field];
    if (!Number.isSafeInteger(amount) || amount < minimum || amount > maximum) {
      errors.push(`buildPolicy.${field} must be a safe integer between ${minimum} and ${maximum}`);
    }
  }
  if (value.buildPolicy?.targetPlatform === null) {
    blockers.push("Control Plane target platform has not been supplied");
  } else if (!["linux/amd64", "linux/arm64"].includes(value.buildPolicy?.targetPlatform)) {
    errors.push("buildPolicy.targetPlatform must be linux/amd64 or linux/arm64");
  }
  exactKeys(
    value.buildPolicy?.runtimeResourceLimits,
    ["cpuMilli", "memoryMiB", "ephemeralStorageMiB"],
    "buildPolicy.runtimeResourceLimits",
    errors,
  );
  for (const field of ["cpuMilli", "memoryMiB", "ephemeralStorageMiB"]) {
    const amount = value.buildPolicy?.runtimeResourceLimits?.[field];
    if (!Number.isSafeInteger(amount) || amount < 1) {
      errors.push(`buildPolicy.runtimeResourceLimits.${field} must be a positive safe integer`);
    }
  }
  exactKeys(
    value.buildPolicy?.cacheRetention,
    ["maxBytes", "maxEntries", "minAgeMs", "maxEvictions"],
    "buildPolicy.cacheRetention",
    errors,
  );
  for (const [field, minimum, maximum] of [
    ["maxBytes", 0, Number.MAX_SAFE_INTEGER],
    ["maxEntries", 1, Number.MAX_SAFE_INTEGER],
    ["minAgeMs", 0, Number.MAX_SAFE_INTEGER],
    ["maxEvictions", 1, 32],
  ]) {
    const amount = value.buildPolicy?.cacheRetention?.[field];
    if (amount === null) {
      blockers.push(`buildPolicy.cacheRetention.${field} has not been supplied`);
    } else if (!Number.isSafeInteger(amount) || amount < minimum || amount > maximum) {
      errors.push(
        `buildPolicy.cacheRetention.${field} must be a safe integer between ${minimum} and ${maximum}`,
      );
    }
  }
  if (Array.isArray(value.buildPolicy?.builderKeys) && value.buildPolicy.builderKeys.length === 0) {
    blockers.push("Control Plane trusted Build Worker public key has not been supplied");
  } else if (!Array.isArray(value.buildPolicy?.builderKeys)) {
    errors.push("buildPolicy.builderKeys must be an array");
  } else {
    if (value.buildPolicy.builderKeys.length > 32)
      errors.push("buildPolicy.builderKeys may contain at most 32 keys");
    const keyIds = new Set();
    for (const [index, key] of value.buildPolicy.builderKeys.entries()) {
      const name = `buildPolicy.builderKeys[${index}]`;
      exactKeys(key, builderKeyKeys, name, errors);
      requiredString(key?.keyId, `${name}.keyId`, errors);
      requiredString(key?.publicKeyBase64, `${name}.publicKeyBase64`, errors);
      if (typeof key?.keyId === "string" && !/^[A-Za-z0-9._:-]{1,128}$/.test(key.keyId)) {
        errors.push(`${name}.keyId must be a safe Ed25519 signing key identifier`);
      }
      if (typeof key?.keyId === "string") {
        if (keyIds.has(key.keyId)) errors.push(`${name}.keyId must be unique`);
        keyIds.add(key.keyId);
      }
      if (typeof key?.publicKeyBase64 === "string") {
        try {
          const bytes = Buffer.from(key.publicKeyBase64, "base64");
          if (bytes.byteLength !== 32 || bytes.toString("base64") !== key.publicKeyBase64) {
            errors.push(
              `${name}.publicKeyBase64 must be canonical base64 for a 32-byte Ed25519 public key`,
            );
          }
        } catch {
          errors.push(
            `${name}.publicKeyBase64 must be canonical base64 for a 32-byte Ed25519 public key`,
          );
        }
      }
      if (typeof key?.revoked !== "boolean") errors.push(`${name}.revoked must be boolean`);
      for (const field of ["validFrom", "validUntil"]) {
        if (key?.[field] !== null && !utcDateTime(key?.[field])) {
          errors.push(`${name}.${field} must be an ISO date or null`);
        }
      }
      if (
        typeof key?.validFrom === "string" &&
        typeof key?.validUntil === "string" &&
        Date.parse(key.validFrom) > Date.parse(key.validUntil)
      ) {
        errors.push(`${name}.validFrom must not be after validUntil`);
      }
    }
    if (
      typeof value.buildWorker?.signingKeyId === "string" &&
      !keyIds.has(value.buildWorker.signingKeyId)
    ) {
      errors.push("buildWorker.signingKeyId must have a matching Control Plane builder key");
    }
  }

  exactKeys(
    value.releasePolicy,
    ["workerId", "operatorActorId", "canaryProbeActorId", "signerIdentityAllowlist", "canary"],
    "releasePolicy",
    errors,
  );
  exactKeys(
    value.releasePolicy?.canary,
    [
      "owner",
      "disposable",
      "production",
      "repositoryId",
      "instanceId",
      "bindingEpoch",
      "authorizationRevision",
      "requestedModules",
      "resourceProfileId",
    ],
    "releasePolicy.canary",
    errors,
  );
  if (value.releasePolicy?.canary?.disposable !== true) {
    errors.push("releasePolicy.canary.disposable must be true for the owned disposable canary");
  }
  if (value.releasePolicy?.canary?.production !== false) {
    errors.push("releasePolicy.canary.production must be false");
  }
  const canaryFields = [
    "owner",
    "repositoryId",
    "instanceId",
    "bindingEpoch",
    "authorizationRevision",
    "requestedModules",
    "resourceProfileId",
  ];
  const canaryConfigured = canaryFields.some(
    (field) => value.releasePolicy?.canary?.[field] !== null,
  );
  const releaseConfigured =
    value.releasePolicy?.workerId !== null ||
    value.releasePolicy?.operatorActorId !== null ||
    value.releasePolicy?.canaryProbeActorId !== null ||
    (Array.isArray(value.releasePolicy?.signerIdentityAllowlist) &&
      value.releasePolicy.signerIdentityAllowlist.length > 0) ||
    canaryConfigured;
  if (!Array.isArray(value.releasePolicy?.signerIdentityAllowlist)) {
    errors.push("releasePolicy.signerIdentityAllowlist must be an array");
  }
  if (releaseConfigured) {
    if (value.releasePolicy?.workerId === null) {
      blockers.push("T11 release worker ID has not been supplied");
    } else {
      requiredString(value.releasePolicy?.workerId, "releasePolicy.workerId", errors);
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(value.releasePolicy?.workerId ?? "")) {
        errors.push(
          "releasePolicy.workerId must match the Control Plane release policy identifier",
        );
      }
    }
    if (value.releasePolicy?.operatorActorId === null) {
      blockers.push("T11 release operator actor ID has not been supplied");
    } else {
      requiredString(value.releasePolicy?.operatorActorId, "releasePolicy.operatorActorId", errors);
      if (
        typeof value.releasePolicy?.operatorActorId === "string" &&
        value.releasePolicy.operatorActorId.length > 128
      ) {
        errors.push("releasePolicy.operatorActorId must be at most 128 characters");
      }
    }
    if (value.releasePolicy?.canaryProbeActorId === null) {
      blockers.push("T11 canary GitHub probe actor user ID has not been supplied");
    } else if (
      !Number.isSafeInteger(value.releasePolicy?.canaryProbeActorId) ||
      value.releasePolicy.canaryProbeActorId < 1
    ) {
      errors.push("releasePolicy.canaryProbeActorId must be a positive GitHub user ID or null");
    }
    if (
      Array.isArray(value.releasePolicy?.signerIdentityAllowlist) &&
      value.releasePolicy.signerIdentityAllowlist.length === 0
    ) {
      blockers.push("T11 trusted Sigstore signer identity allowlist has not been supplied");
    } else if (Array.isArray(value.releasePolicy?.signerIdentityAllowlist)) {
      if (value.releasePolicy.signerIdentityAllowlist.length > 32) {
        errors.push("releasePolicy.signerIdentityAllowlist may contain at most 32 identities");
      }
      for (const [index, identity] of value.releasePolicy.signerIdentityAllowlist.entries()) {
        const name = `releasePolicy.signerIdentityAllowlist[${index}]`;
        if (identity && typeof identity === "object" && !Array.isArray(identity)) {
          exactKeys(
            identity,
            Object.hasOwn(identity, "issuer") ? signerIdentityKeys : ["subjectAlternativeName"],
            name,
            errors,
          );
        } else {
          errors.push(`${name} must be a strict signer identity object`);
          continue;
        }
        requiredString(identity.subjectAlternativeName, `${name}.subjectAlternativeName`, errors);
        if (
          typeof identity.subjectAlternativeName === "string" &&
          identity.subjectAlternativeName.length > 1024
        ) {
          errors.push(`${name}.subjectAlternativeName must be at most 1024 characters`);
        }
        if (Object.hasOwn(identity, "issuer")) {
          requiredString(identity.issuer, `${name}.issuer`, errors);
          if (typeof identity.issuer === "string" && identity.issuer.length > 1024) {
            errors.push(`${name}.issuer must be at most 1024 characters`);
          }
        }
      }
    }

    const canary = value.releasePolicy?.canary;
    for (const [field, message] of [
      ["owner", "T11 disposable canary owner has not been supplied"],
      ["repositoryId", "T11 canary repository ID has not been supplied"],
      ["instanceId", "T11 canary instance ID has not been supplied"],
      ["bindingEpoch", "T11 canary binding epoch has not been supplied"],
      ["authorizationRevision", "T11 canary authorization revision has not been supplied"],
      ["requestedModules", "T11 canary module selection has not been supplied"],
      ["resourceProfileId", "T11 canary resource profile ID has not been supplied"],
    ]) {
      if (canary?.[field] === null) blockers.push(message);
    }
    if (canary?.owner !== null) {
      requiredString(canary?.owner, "releasePolicy.canary.owner", errors);
      if (typeof canary?.owner === "string" && canary.owner.length > 128) {
        errors.push("releasePolicy.canary.owner must be at most 128 characters");
      }
    }
    if (
      canary?.repositoryId !== null &&
      (!Number.isSafeInteger(canary?.repositoryId) || canary.repositoryId < 1)
    ) {
      errors.push("releasePolicy.canary.repositoryId must be a positive safe integer or null");
    }
    if (
      canary?.instanceId !== null &&
      (typeof canary?.instanceId !== "string" ||
        !/^ins_[0-9A-HJKMNP-TV-Z]{26}$/.test(canary.instanceId))
    ) {
      errors.push("releasePolicy.canary.instanceId must be a canonical instance ID or null");
    }
    for (const field of ["bindingEpoch", "authorizationRevision"]) {
      const revision = canary?.[field];
      if (revision !== null && (!Number.isSafeInteger(revision) || revision < 0)) {
        errors.push(`releasePolicy.canary.${field} must be a nonnegative safe integer or null`);
      }
    }
    if (canary?.requestedModules !== null) {
      if (!Array.isArray(canary?.requestedModules)) {
        errors.push("releasePolicy.canary.requestedModules must be an array or null");
      } else {
        if (canary.requestedModules.length > 128) {
          errors.push("releasePolicy.canary.requestedModules may contain at most 128 modules");
        }
        for (const [index, module] of canary.requestedModules.entries()) {
          requiredString(module, `releasePolicy.canary.requestedModules[${index}]`, errors);
          if (typeof module === "string" && module.length > 128) {
            errors.push(
              `releasePolicy.canary.requestedModules[${index}] must be at most 128 characters`,
            );
          }
        }
      }
    }
    if (canary?.resourceProfileId !== null) {
      requiredString(canary?.resourceProfileId, "releasePolicy.canary.resourceProfileId", errors);
      if (typeof canary?.resourceProfileId === "string" && canary.resourceProfileId.length > 128) {
        errors.push("releasePolicy.canary.resourceProfileId must be at most 128 characters");
      }
    }
  }

  const optionalImages = ["coordination", "observer"];
  exactKeys(value.images, [...imageKeys, ...optionalImages], "images", errors, optionalImages);
  for (const name of [...imageKeys, ...optionalImages.filter((key) => value.images?.[key] != null)]) {
    const image = value.images?.[name];
    if (image === null || image === "") {
      blockers.push(`immutable ${name} image digest is not available`);
      continue;
    }
    requiredString(image, `images.${name}`, errors);
    if (!/^([a-z0-9.-]+\/)+[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(image ?? "")) {
      errors.push(`images.${name} must be a repository-qualified immutable sha256 digest`);
    }
    if (/example|placeholder|replace|000000/i.test(image ?? "")) {
      errors.push(`images.${name} contains a placeholder identity`);
    }
  }

  exactKeys(
    value.secretRefs,
    [...secretKeys, ...workNotificationSecretKeys],
    "secretRefs",
    errors,
    workNotificationsEnabled ? [] : workNotificationSecretKeys,
  );
  for (const name of secretKeys)
    validateSecretRef(value.secretRefs?.[name], `secretRefs.${name}`, errors);
  for (const name of workNotificationSecretKeys) {
    if (workNotificationsEnabled && !Object.hasOwn(value.secretRefs ?? {}, name)) {
      blockers.push(`secretRefs.${name} is required when workNotifications.enabled is true`);
    } else if (Object.hasOwn(value.secretRefs ?? {}, name)) {
      validateSecretRef(value.secretRefs[name], `secretRefs.${name}`, errors);
    }
  }
  if (value.secretRefs?.applicationImagePull?.key !== ".dockerconfigjson") {
    errors.push(
      "secretRefs.applicationImagePull.key must be .dockerconfigjson for a dockerconfigjson pull secret",
    );
  }

  if (typeof value.acmeContactEmail !== "string" || value.acmeContactEmail.trim() === "") {
    blockers.push("ACME contact email has not been supplied");
  } else if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(value.acmeContactEmail)) {
    errors.push("acmeContactEmail must be an email address");
  } else if (
    value.environment !== "disposable-test" &&
    /(^|\.)(localhost|test|invalid|example)$/i.test(value.acmeContactEmail.split("@")[1])
  ) {
    errors.push("acmeContactEmail must not use a reserved test domain");
  }

  if (value.environment === "disposable-test" &&
      !["local", "remote-disposable"].includes(value.cloudflare?.mode)) {
    errors.push("disposable-test inventory must use local or remote-disposable Worker/D1 mode");
  }
  if (value.environment === "deployment" && value.cloudflare?.mode !== "remote") {
    errors.push("deployment inventory requires a real remote Cloudflare account");
  }
  if (value.cloudflare?.mode === "remote-disposable") {
    if (value.environment !== "disposable-test") {
      errors.push("remote-disposable Cloudflare mode is restricted to disposable-test inventories");
    }
    const clusterName = value.ownership?.clusterName;
    if (
      typeof clusterName !== "string" ||
      !/^praetorium-t14-[a-z0-9](?:[a-z0-9-]{0,32}[a-z0-9])?$/u.test(clusterName)
    ) {
      errors.push(
        "remote-disposable ownership.clusterName must use the bounded praetorium-t14- prefix",
      );
    } else {
      const controlPlaneName = `${clusterName}-control-plane`;
      const gatewayName = `${clusterName}-gateway`;
      if (
        controlPlaneName.length > 63 ||
        gatewayName.length > 63 ||
        [productionCloudflareResources.controlPlaneWorker, productionCloudflareResources.gatewayWorker]
          .includes(controlPlaneName) ||
        [productionCloudflareResources.controlPlaneWorker, productionCloudflareResources.gatewayWorker]
          .includes(gatewayName)
      ) {
        errors.push("remote-disposable Worker names must be unique test-prefixed names");
      }
    }
    if (
      value.cloudflare?.controlPlaneDatabaseId ===
        productionCloudflareResources.controlPlaneDatabaseId ||
      value.cloudflare?.gatewayKvNamespaceId === productionCloudflareResources.gatewayKvNamespaceId
    ) {
      errors.push("remote-disposable Cloudflare resource IDs must not reference production D1 or KV");
    }
    if (value.workNotifications?.enabled === true) {
      errors.push("remote-disposable Workers must use bounded polling without shared work-notification bindings");
    }
    if (clusterName) {
      const workerOrigin = (raw, expectedName, field) => {
        try {
          const url = new URL(raw);
          if (
            url.protocol !== "https:" || url.origin !== raw || url.pathname !== "/" ||
            url.username || url.password || url.search || url.hash ||
            !new RegExp(`^${expectedName}\\.[a-z0-9-]+\\.workers\\.dev$`, "u").test(url.hostname)
          ) {
            errors.push(`remote-disposable ${field} must be the matching workers.dev origin`);
          }
        } catch {
          errors.push(`remote-disposable ${field} must be an HTTPS workers.dev origin`);
        }
      };
      workerOrigin(value.domains?.controlPlaneUrl, `${clusterName}-control-plane`, "domains.controlPlaneUrl");
      workerOrigin(value.domains?.gatewayOrigin, `${clusterName}-gateway`, "domains.gatewayOrigin");
      if (value.domains?.gatewayServiceUrl !== value.domains?.gatewayOrigin) {
        errors.push("remote-disposable domains.gatewayServiceUrl must equal the test Gateway origin");
      }
      if (value.gateway?.adminOrigin !== null || value.gateway?.adminGithubUserIds?.length) {
        errors.push("remote-disposable inventories must not configure the production Admin Worker");
      }
    }
  }
  return { errors, blockers };
}

export function readInventory(filePath) {
  const absolutePath = path.resolve(filePath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read inventory ${absolutePath}: ${error.message}`);
  }
  return { absolutePath, inventory: parsed, ...validateInventory(parsed) };
}

export function isMissingIntegrationInput(message) {
  return /not available|has no owned test resources/.test(message);
}
