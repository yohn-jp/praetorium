// Shared canonical Worker environment projection for local and K3s deployments.
import { workNotificationEndpoints, workNotificationsEnabled } from "./work-notifications.mjs";

export function buildPolicy(inventory) {
  const repository = inventory.buildkit.outputRepository;
  const builderKeys = inventory.buildPolicy.builderKeys;
  const cacheRetention = inventory.buildPolicy.cacheRetention;
  const retentionFields = ["maxBytes", "maxEntries", "minAgeMs", "maxEvictions"];
  if (
    !repository ||
    inventory.buildPolicy.targetPlatform === null ||
    builderKeys.length === 0 ||
    !cacheRetention ||
    !retentionFields.every(
      (field) => Object.hasOwn(cacheRetention, field) && cacheRetention[field] !== null,
    )
  )
    return null;
  const outputRepository = repository.slice("ghcr.io/".length);
  return {
    registryUrl: inventory.buildPolicy.registryUrl,
    allowedRepositories: [
      ...new Set(
        [
          outputRepository,
          inventory.buildkit.frontendRepository,
          inventory.buildWorker.compositionRepository,
        ]
          .filter((value) => typeof value === "string" && value.length > 0)
          .map((value) => value.replace(/^ghcr\.io\//u, "")),
      ),
    ],
    outputRepository,
    maxImageLayerBytes: inventory.buildPolicy.maxImageLayerBytes,
    maxImageVerificationMs: inventory.buildPolicy.maxImageVerificationMs,
    maxRegistryRequestMs: inventory.buildPolicy.maxRegistryRequestMs,
    runtimeResourceLimits: inventory.buildPolicy.runtimeResourceLimits,
    cacheRetention,
    targetPlatform: inventory.buildPolicy.targetPlatform,
    builderKeys: builderKeys.map((key) => ({
      keyId: key.keyId,
      publicKeyBase64: key.publicKeyBase64,
      revoked: key.revoked,
      ...(key.validFrom === null ? {} : { validFrom: key.validFrom }),
      ...(key.validUntil === null ? {} : { validUntil: key.validUntil }),
    })),
  };
}

export function releasePolicy(inventory) {
  const release = inventory.releasePolicy;
  const canary = release.canary;
  if (
    release.workerId === null ||
    release.operatorActorId === null ||
    release.canaryProbeActorId === null ||
    release.signerIdentityAllowlist.length === 0 ||
    canary.owner === null ||
    canary.repositoryId === null ||
    canary.instanceId === null ||
    canary.bindingEpoch === null ||
    canary.authorizationRevision === null ||
    canary.requestedModules === null ||
    canary.resourceProfileId === null
  ) {
    return null;
  }
  return {
    workerId: release.workerId,
    clusterId: inventory.clusterId,
    operatorActorId: release.operatorActorId,
    canaryProbeActorId: release.canaryProbeActorId,
    signerIdentityAllowlist: release.signerIdentityAllowlist,
    canary,
  };
}

function setStringVariable(variables, key, value) {
  if (value !== null && value !== undefined) variables[key] = String(value);
}

export function renderWorkerTemplate(template, inventory, worker) {
  const config = JSON.parse(template);
  if (worker === "control-plane") {
    const variables = {};
    setStringVariable(variables, "CONTROL_PLANE_ORIGIN", inventory.domains.controlPlaneUrl);
    setStringVariable(variables, "GATEWAY_ORIGIN", inventory.domains.gatewayOrigin);
    setStringVariable(
      variables,
      "GIT_CREDENTIAL_BROKER_LOCATOR",
      inventory.domains.gatewayOrigin == null
        ? null
        : new URL("/internal/github/credential", inventory.domains.gatewayOrigin).href,
    );
    setStringVariable(variables, "INSTANCE_HOST_SUFFIX", inventory.domains.instanceHostnameSuffix);
    setStringVariable(
      variables,
      "RUNTIME_REGISTRY_HOST",
      new URL(inventory.buildPolicy.registryUrl).host,
    );
    setStringVariable(variables, "BUILD_WORKER_ID", `${inventory.clusterId}-build-worker`);
    setStringVariable(variables, "PROVISIONER_WORKER_ID", `${inventory.clusterId}-provisioner`);
    setStringVariable(variables, "PROVISIONER_CLUSTER_ID", inventory.clusterId);
    if (workNotificationsEnabled(inventory)) {
      const endpoints = workNotificationEndpoints(inventory);
      setStringVariable(variables, "PROVISIONER_WORK_NOTIFICATION_URL", endpoints.provisioner);
      setStringVariable(variables, "BUILD_WORK_NOTIFICATION_URL", endpoints.build);
      if (inventory.workNotifications.coordinationVpcServiceId) {
        config.vpc_services = [{
          binding: "COORDINATION_SERVICE",
          service_id: inventory.workNotifications.coordinationVpcServiceId,
        }];
      }
    }
    const policy = buildPolicy(inventory);
    if (policy) variables.BUILD_POLICY_JSON = JSON.stringify(policy);
    const releases = releasePolicy(inventory);
    if (releases) variables.RELEASE_POLICY_JSON = JSON.stringify(releases);
    config.vars = variables;
  } else {
    config.vars = {
      GATEWAY_ENVIRONMENT: inventory.environment === "deployment" ? "production" : "test",
      GATEWAY_SESSION_TTL_SECONDS: "43200",
      GATEWAY_HANDOFF_TTL_SECONDS: "60",
      GATEWAY_ACCESS_GRANT_TTL_SECONDS: "300",
      ...Object.fromEntries(
        Object.entries({
          GATEWAY_ORIGIN: inventory.domains.gatewayOrigin,
          CONTROL_PLANE_ORIGIN: inventory.domains.controlPlaneUrl,
          GATEWAY_INSTANCE_HOSTNAME_SUFFIX: inventory.domains.instanceHostnameSuffix,
          GATEWAY_ALLOWED_REPOSITORY_OWNER: inventory.gateway.allowedRepositoryOwner,
          GITHUB_APP_ID: inventory.gateway.githubAppId,
          GITHUB_OAUTH_CLIENT_ID: inventory.gateway.githubOauthClientId,
          GATEWAY_TOKEN_ENCRYPTION_KEY_ID: inventory.gateway.tokenEncryptionKeyId,
        })
          .filter(([, value]) => value !== null && value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      ),
    };
  }
  if (worker === "control-plane") {
    config.d1_databases[0].database_id = inventory.cloudflare.controlPlaneDatabaseId;
  } else {
    config.kv_namespaces[0].id = inventory.cloudflare.gatewayKvNamespaceId;
    config.kv_namespaces[0].preview_id = inventory.cloudflare.gatewayKvNamespaceId;
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}
