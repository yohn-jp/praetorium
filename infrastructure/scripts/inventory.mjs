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
  "buildkit",
  "buildWorker",
  "images",
  "secretRefs",
  "acmeContactEmail",
];

const imageKeys = ["provisioner", "instanceAccess", "buildWorker", "prometheus"];
const secretKeys = [
  "controlPlaneCredential",
  "instanceAccessServiceAuth",
  "buildWorkerControlPlaneAuth",
  "buildWorkerSigningKey",
  "buildWorkerRegistryPush",
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
    value.split(".").every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  );
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
    if (value.cloudflare.accountId !== null) errors.push("local Cloudflare mode must not include an accountId");
    if (!/^00000000-0000-0000-0000-[0-9]{12}$/.test(value.cloudflare?.controlPlaneDatabaseId ?? "")) {
      errors.push("local Cloudflare mode requires a local-only controlPlaneDatabaseId");
    }
    if (value.cloudflare?.gatewayKvNamespaceId !== "00000000000000000000000000000000") {
      errors.push("local Cloudflare mode requires the local-only gatewayKvNamespaceId");
    }
  } else {
    requiredString(value.cloudflare?.accountId, "cloudflare.accountId", errors);
    if (!/^[a-f0-9]{32}$/.test(value.cloudflare?.accountId ?? "") || value.cloudflare?.accountId === "00000000000000000000000000000000") {
      errors.push("cloudflare.accountId must be a 32-character account ID");
    }
    requiredString(value.cloudflare?.controlPlaneDatabaseId, "cloudflare.controlPlaneDatabaseId", errors);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.cloudflare?.controlPlaneDatabaseId ?? "") ||
      /^00000000-0000-0000-0000-[0-9]{12}$/.test(value.cloudflare?.controlPlaneDatabaseId ?? "")) {
      errors.push("cloudflare.controlPlaneDatabaseId must be a real non-placeholder D1 database ID");
    }
    requiredString(value.cloudflare?.gatewayKvNamespaceId, "cloudflare.gatewayKvNamespaceId", errors);
    if (!/^[a-f0-9]{32}$/.test(value.cloudflare?.gatewayKvNamespaceId ?? "") ||
      value.cloudflare?.gatewayKvNamespaceId === "00000000000000000000000000000000") {
      errors.push("cloudflare.gatewayKvNamespaceId must be a real non-placeholder KV namespace ID");
    }
  }

  exactKeys(
    value.domains,
    ["gatewayOrigin", "gatewayServiceUrl", "controlPlaneUrl", "instanceHostnameSuffix", "tlsSecretName"],
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
      blockers.push("HTTPS Control Plane URL reachable from the Provisioner pod has not been supplied");
      continue;
    }
    if (raw === null && field === "gatewayServiceUrl") {
      blockers.push("Gateway service URL reachable from the Node Instance Access pod has not been supplied");
      continue;
    }
    requiredString(raw, `domains.${field}`, errors);
    try {
      const url = new URL(raw);
      const local = value.environment === "disposable-test";
      const allowedProtocols = field === "gatewayOrigin" || field === "controlPlaneUrl"
        ? ["https:"]
        : local ? ["http:", "https:"] : ["https:"];
      if (!allowedProtocols.includes(url.protocol)) errors.push(`domains.${field} must use ${allowedProtocols.join(" or ")}`);
      if (url.username || url.password || url.hash || url.search || url.pathname !== "/") {
        errors.push(`domains.${field} must be an origin without credentials, path, query, or fragment`);
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
  if (typeof value.domains?.tlsSecretName === "string" &&
    !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(value.domains.tlsSecretName)) {
    errors.push("domains.tlsSecretName must be a Kubernetes DNS subdomain");
  }

  exactKeys(value.buildkit, ["endpoint", "tlsSecretName", "allowedClientCidrs", "frontendRepository", "outputRepository"], "buildkit", errors);
  if (value.buildkit?.endpoint !== null) {
    requiredString(value.buildkit?.endpoint, "buildkit.endpoint", errors);
    if (!/^tcp:\/\/[a-z0-9.-]+:[0-9]{1,5}$/.test(value.buildkit?.endpoint ?? "")) {
      errors.push("buildkit.endpoint must be tcp://host:port or null");
    } else if (value.environment !== "disposable-test" && reservedHostname(value.buildkit.endpoint.slice("tcp://".length).replace(/:[0-9]+$/, ""))) {
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
      const parsed = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/([0-9]|[12][0-9]|3[0-2])$/.exec(cidr);
      if (!parsed || parsed.slice(1, 5).some((octet) => Number(octet) > 255) || parsed?.[5] === "0") {
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
    if (typeof repository === "string" && (!/^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(repository) || reservedRepositoryPath(repository))) {
      errors.push(`buildkit.${field} must be a real GHCR repository path`);
    }
  }

  exactKeys(value.buildWorker, ["signingKeyId", "compositionRepository", "buildctlPath"], "buildWorker", errors);
  for (const field of ["signingKeyId", "compositionRepository", "buildctlPath"]) {
    if (value.buildWorker?.[field] === null) {
      blockers.push(`Build Worker ${field} has not been supplied`);
    } else {
      requiredString(value.buildWorker?.[field], `buildWorker.${field}`, errors);
    }
  }
  if (typeof value.buildWorker?.signingKeyId === "string" && (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(value.buildWorker.signingKeyId) || /^(?:example|placeholder|replace|changeme|todo|sample|dummy|test)(?:$|[^a-z0-9])/i.test(value.buildWorker.signingKeyId))) {
    errors.push("buildWorker.signingKeyId must be a safe public key identifier");
  }
  if (typeof value.buildWorker?.compositionRepository === "string" && (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(value.buildWorker.compositionRepository) || reservedRepositoryPath(value.buildWorker.compositionRepository))) {
    errors.push("buildWorker.compositionRepository must be a real owner/repository path");
  }
  if (typeof value.buildWorker?.buildctlPath === "string" && (!value.buildWorker.buildctlPath.startsWith("/") || value.buildWorker.buildctlPath.split("/").includes(".."))) {
    errors.push("buildWorker.buildctlPath must be an absolute path without parent traversal");
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
  for (const name of secretKeys) validateSecretRef(value.secretRefs?.[name], `secretRefs.${name}`, errors);
  if (value.secretRefs?.applicationImagePull?.key !== ".dockerconfigjson") {
    errors.push("secretRefs.applicationImagePull.key must be .dockerconfigjson for a dockerconfigjson pull secret");
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
