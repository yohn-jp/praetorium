import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { systemNetworkRenderValues } from "./system-network.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function renderValues(inventory) {
  const secret = inventory.secretRefs;
  return {
    ...systemNetworkRenderValues(inventory),
    "@@CLUSTER_ID@@": inventory.clusterId,
    "@@PROVISIONER_WORKER_ID@@": `${inventory.clusterId}-provisioner`,
    "@@PROVISIONER_MAX_CPU_MILLI@@": String(inventory.buildPolicy.runtimeResourceLimits.cpuMilli),
    "@@PROVISIONER_MAX_MEMORY_MIB@@": String(inventory.buildPolicy.runtimeResourceLimits.memoryMiB),
    "@@PROVISIONER_MAX_EPHEMERAL_STORAGE_MIB@@": String(
      inventory.buildPolicy.runtimeResourceLimits.ephemeralStorageMiB,
    ),
    "@@ENVIRONMENT@@": inventory.environment,
    "@@INSTANCE_HOSTNAME_SUFFIX@@": inventory.domains.instanceHostnameSuffix,
    "@@TLS_SECRET_NAME@@": inventory.domains.tlsSecretName,
    "@@GATEWAY_ORIGIN@@": inventory.domains.gatewayOrigin,
    "@@GATEWAY_SERVICE_URL@@": inventory.domains.gatewayServiceUrl,
    "@@NODE_ENV@@": inventory.environment === "disposable-test" ? "test" : "production",
    "@@CONTROL_PLANE_URL@@": inventory.domains.controlPlaneUrl,
    "@@BUILDKIT_ENDPOINT@@": inventory.buildkit.endpoint,
    "@@BUILDKIT_SERVER_NAME@@": inventory.buildkit.endpoint
      ? new URL(inventory.buildkit.endpoint).hostname
      : null,
    "@@BUILDKIT_FRONTEND_REPOSITORY@@": inventory.buildkit.frontendRepository,
    "@@BUILDKIT_OUTPUT_REPOSITORY@@": inventory.buildkit.outputRepository,
    "@@BUILD_WORKER_ID@@": `${inventory.clusterId}-build-worker`,
    "@@BUILD_WORKER_CONTROL_PLANE_URL@@": inventory.domains.controlPlaneUrl,
    "@@BUILD_WORKER_SIGNING_KEY_ID@@": inventory.buildWorker.signingKeyId,
    "@@BUILD_WORKER_COMPOSITION_REPOSITORY@@": inventory.buildWorker.compositionRepository,
    "@@BUILD_REGISTRY_URL@@": inventory.buildPolicy.registryUrl,
    "@@BUILD_MAX_IMAGE_LAYER_BYTES@@": String(inventory.buildPolicy.maxImageLayerBytes),
    "@@BUILD_MAX_IMAGE_VERIFICATION_MS@@": String(inventory.buildPolicy.maxImageVerificationMs),
    "@@BUILD_MAX_REGISTRY_REQUEST_MS@@": String(inventory.buildPolicy.maxRegistryRequestMs),
    "@@BUILD_WORKER_BUILDKIT_PATH@@": inventory.buildWorker.buildctlPath,
    "@@IMAGE_PROVISIONER@@": inventory.images.provisioner,
    "@@IMAGE_INSTANCE_ACCESS@@": inventory.images.instanceAccess,
    "@@IMAGE_BUILD_WORKER@@": inventory.images.buildWorker,
    "@@IMAGE_PROMETHEUS@@": inventory.images.prometheus,
    "@@SECRET_PROVISIONER_CREDENTIAL@@": secret.controlPlaneCredential.name,
    "@@SECRET_PROVISIONER_CREDENTIAL_KEY@@": secret.controlPlaneCredential.key,
    "@@SECRET_INSTANCE_ACCESS_AUTH@@": secret.instanceAccessServiceAuth.name,
    "@@SECRET_INSTANCE_ACCESS_AUTH_KEY@@": secret.instanceAccessServiceAuth.key,
    "@@SECRET_BUILD_WORKER_AUTH@@": secret.buildWorkerControlPlaneAuth.name,
    "@@SECRET_BUILD_WORKER_AUTH_KEY@@": secret.buildWorkerControlPlaneAuth.key,
    "@@SECRET_BUILD_WORKER_SIGNING_KEY@@": secret.buildWorkerSigningKey.name,
    "@@SECRET_BUILD_WORKER_SIGNING_KEY_KEY@@": secret.buildWorkerSigningKey.key,
    "@@SECRET_REGISTRY_PUSH@@": secret.buildWorkerRegistryPush.name,
    "@@SECRET_REGISTRY_PUSH_KEY@@": secret.buildWorkerRegistryPush.key,
    "@@SECRET_REGISTRY_PULL@@": secret.buildWorkerRegistryPull.name,
    "@@SECRET_REGISTRY_PULL_KEY@@": secret.buildWorkerRegistryPull.key,
    "@@SECRET_APPLICATION_IMAGE_PULL@@": secret.applicationImagePull.name,
    "@@SECRET_BUILDKIT_CLIENT@@": secret.buildkitClient.name,
    "@@SECRET_BUILDKIT_CA_KEY@@": secret.buildkitClient.caKey,
    "@@SECRET_BUILDKIT_CERT_KEY@@": secret.buildkitClient.certKey,
    "@@SECRET_BUILDKIT_PRIVATE_KEY@@": secret.buildkitClient.privateKey,
    "@@SECRET_CLOUDFLARE_DNS_TOKEN@@": secret.cloudflareDnsApiToken.name,
    "@@SECRET_CLOUDFLARE_DNS_TOKEN_KEY@@": secret.cloudflareDnsApiToken.key,
    "@@ACME_CONTACT_EMAIL@@": inventory.acmeContactEmail,
  };
}

function renderTree(source, destination, values) {
  cpSync(source, destination, { recursive: true, errorOnExist: true });
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  visit(destination);
  for (const file of files) {
    const original = readFileSync(file, "utf8");
    let rendered = original;
    for (const [token, value] of Object.entries(values)) {
      if (value !== null && value !== undefined)
        rendered = rendered.replaceAll(token, String(value));
    }
    writeFileSync(file, rendered, { mode: 0o600 });
  }
  const unresolved = files.filter((file) => /@@[A-Z0-9_]+@@/.test(readFileSync(file, "utf8")));
  if (unresolved.length > 0) {
    throw new Error(
      `rendered infrastructure contains unresolved placeholders: ${unresolved.map((file) => path.relative(destination, file)).join(", ")}`,
    );
  }
}

export function renderPlatformBundle(inventory, { overlay, buildKustomize }) {
  if (!["disposable", "deployment"].includes(overlay)) throw new Error("invalid platform Kustomize overlay");
  if (typeof buildKustomize !== "function") throw new TypeError("buildKustomize callback required");
  if (overlay === "deployment" && (inventory.environment !== "deployment" || inventory.ownership.provider !== "k3s")) {
    throw new Error("deployment overlay requires deployment environment and k3s ownership");
  }
  const temporary = mkdtempSync(path.join(os.tmpdir(), "praetorium-t12-kustomize-"));
  try {
    const rendered = path.join(temporary, "kubernetes");
    renderTree(path.join(repoRoot, "infrastructure/kubernetes"), rendered, renderValues(inventory));
    const bundle = buildKustomize(path.join(rendered, "overlays", overlay));
    if (
      /@@[A-Z0-9_]+@@/.test(bundle) ||
      /^\s*(?:name|namespace):\s*["']?praetorium-instances(?:-|\s|["']|$)/m.test(bundle)
    ) {
      throw new Error(
        "static Kustomize bundle contains placeholders or dynamic instance namespaces",
      );
    }
    return bundle;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

