import { readFileSync } from "node:fs";
import path from "node:path";

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
  "gateway",
  "buildkit",
  "buildWorker",
  "buildPolicy",
  "images",
  "secretRefs",
  "acmeContactEmail",
];

const imageKeys = ["provisioner", "instanceAccess", "buildWorker", "prometheus"];
const builderKeyKeys = ["keyId", "publicKeyBase64", "revoked", "validFrom", "validUntil"];
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

function exactKeys(value, expected, name, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${name} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    errors.push(`${name} must contain exactly: ${wanted.join(", ")}`);
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
  exactKeys(value, inventoryKeys, "inventory", errors);
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
  if (value.ownership?.provider !== "kind") errors.push("ownership.provider must be kind");
  requiredString(value.ownership?.clusterName, "ownership.clusterName", errors);
  requiredString(value.ownership?.context, "ownership.context", errors);
  if (value.ownership?.disposable !== true) errors.push("ownership.disposable must be true");
  if (value.ownership?.confirmation !== value.ownership?.clusterName) {
    errors.push("ownership.confirmation must repeat the explicit disposable cluster name");
  }
  if (value.ownership?.context !== `kind-${value.ownership?.clusterName}`) {
    errors.push("ownership.context must be the Kind context for ownership.clusterName");
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
  if (value.cloudflare?.mode !== "local" && value.cloudflare?.mode !== "remote-disposable") {
    errors.push("cloudflare.mode must be local or remote-disposable");
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

  exactKeys(
    value.gateway,
    ["allowedRepositoryOwner", "githubAppId", "githubOauthClientId", "tokenEncryptionKeyId"],
    "gateway",
    errors,
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

  exactKeys(
    value.buildPolicy,
    [
      "registryUrl",
      "maxImageLayerBytes",
      "maxImageVerificationMs",
      "maxRegistryRequestMs",
      "targetPlatform",
      "runtimeResourceLimits",
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

  exactKeys(value.images, imageKeys, "images", errors);
  for (const name of imageKeys) {
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

  exactKeys(value.secretRefs, secretKeys, "secretRefs", errors);
  for (const name of secretKeys)
    validateSecretRef(value.secretRefs?.[name], `secretRefs.${name}`, errors);
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

  if (value.environment === "disposable-test" && value.cloudflare?.mode !== "local") {
    errors.push("disposable-test inventory must use local Worker/D1 mode");
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
