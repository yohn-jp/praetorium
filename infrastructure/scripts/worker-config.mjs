// Shared canonical Worker environment projection for local and K3s deployments.
import { createHash } from "node:crypto";
import { workNotificationEndpoints, workNotificationsEnabled } from "./work-notifications.mjs";

const productionRateLimitNamespaces = new Set([761101, 761102, 761103, 761104, 761105, 761106]);
const rateLimitBindingNames = [
  "LOGIN_RATE_LIMIT",
  "MCP_SOURCE_RATE_LIMIT",
  "MCP_CREDENTIAL_RATE_LIMIT",
  "RUNTIME_GIT_RATE_LIMIT",
  "WAKE_RATE_LIMIT",
  "MUTATION_RECEIPT_RATE_LIMIT",
];

export function remoteDisposableWorkerNames(inventory) {
  if (inventory.cloudflare?.mode !== "remote-disposable") {
    throw new TypeError("remote disposable Worker names require remote-disposable Cloudflare mode");
  }
  const prefix = inventory.ownership?.clusterName;
  if (typeof prefix !== "string" || !/^praetorium-t14-[a-z0-9](?:[a-z0-9-]{0,32}[a-z0-9])?$/u.test(prefix)) {
    throw new TypeError("remote disposable Worker names require the bounded praetorium-t14 cluster prefix");
  }
  return Object.freeze({
    controlPlane: `${prefix}-control-plane`,
    gateway: `${prefix}-gateway`,
    database: `${prefix}-control-plane`,
    kvNamespace: `${prefix}-gateway`,
  });
}

export function remoteDisposableRateLimitNamespaces(inventory) {
  const { clusterName } = inventory.ownership ?? {};
  if (inventory.cloudflare?.mode !== "remote-disposable" ||
      typeof clusterName !== "string" ||
      !/^praetorium-t14-[a-z0-9](?:[a-z0-9-]{0,32}[a-z0-9])?$/u.test(clusterName)) {
    throw new TypeError("remote disposable rate limits require the bounded T14 inventory");
  }
  const used = new Set();
  return Object.freeze(Object.fromEntries(rateLimitBindingNames.map((binding) => {
    const hash = createHash("sha256").update(`${clusterName}:rate-limit:${binding}`).digest();
    let id = (hash.readUInt32BE(0) & 0x7fffffff) % 2_000_000_000 + 1;
    while (used.has(id) || productionRateLimitNamespaces.has(id)) {
      id = id === 2_000_000_000 ? 1 : id + 1;
    }
    used.add(id);
    return [binding, id];
  })));
}

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
    ...(inventory.buildkit.frontendRepository
      ? { sourceProducerRepository: inventory.buildkit.frontendRepository } : {}),
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
  if (!["control-plane", "gateway", "admin"].includes(worker))
    throw new TypeError("Unknown Worker projection role");
  const remoteDisposable = inventory.cloudflare?.mode === "remote-disposable";
  if (remoteDisposable && worker === "admin") {
    throw new TypeError("remote-disposable deploys only the isolated Control Plane and Gateway Workers");
  }
  if (remoteDisposable) {
    const names = remoteDisposableWorkerNames(inventory);
    config.name = worker === "control-plane" ? names.controlPlane : names.gateway;
    config.workers_dev = true;
    delete config.routes;
    delete config.vpc_services;
  }
  if (worker === "admin") {
    if (!inventory.gateway.adminOrigin)
      throw new TypeError("Admin origin is required by the independent Worker");
    config.vars = {
      ADMIN_ORIGIN: inventory.gateway.adminOrigin,
      GATEWAY_ORIGIN: inventory.domains.gatewayOrigin,
    };
    config.routes = [{
      pattern: new URL(inventory.gateway.adminOrigin).hostname, custom_domain: true,
    }];
    if (inventory.gateway.adminObserverVpcServiceId) {
      config.vpc_services = [{
        binding: "INFRASTRUCTURE",
        service_id: inventory.gateway.adminObserverVpcServiceId,
      }];
    }
    return `${JSON.stringify(config, null, 2)}\n`;
  }
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
    if (remoteDisposable) {
      const names = remoteDisposableWorkerNames(inventory);
      const database = config.d1_databases?.find((binding) => binding.binding === "CONTROL_PLANE_DB");
      if (!database) throw new TypeError("Control Plane template is missing CONTROL_PLANE_DB");
      database.database_name = names.database;
      const gateway = config.services?.find((binding) => binding.binding === "GATEWAY_SERVICE");
      if (!gateway) throw new TypeError("Control Plane template is missing GATEWAY_SERVICE");
      gateway.service = names.gateway;
    }
  } else {
    config.vars = {
      GATEWAY_ENVIRONMENT: inventory.environment === "deployment" ? "production" : "test",
      GATEWAY_SESSION_TTL_SECONDS: "28800",
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
          PRAETORIUM_ADMIN_ORIGIN: inventory.gateway.adminOrigin,
          PRAETORIUM_ADMIN_GITHUB_USER_IDS: inventory.gateway.adminGithubUserIds?.length
            ? inventory.gateway.adminGithubUserIds.join(",") : undefined,
          PRAETORIUM_RELEASE_SOURCES_JSON: inventory.gateway.releaseSources?.length
            ? JSON.stringify(inventory.gateway.releaseSources) : undefined,
        })
          .filter(([, value]) => value !== null && value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      ),
    };
  }
  if (!remoteDisposable) {
    const origins = worker === "control-plane"
      ? [inventory.domains.controlPlaneUrl]
      : [inventory.domains.gatewayOrigin];
    config.routes = origins.filter(Boolean).map(origin => ({
      pattern: new URL(origin).hostname, custom_domain: true,
    }));
  }
  if (worker === "control-plane") {
    config.d1_databases[0].database_id = inventory.cloudflare.controlPlaneDatabaseId;
  } else {
    config.kv_namespaces[0].id = inventory.cloudflare.gatewayKvNamespaceId;
    config.kv_namespaces[0].preview_id = inventory.cloudflare.gatewayKvNamespaceId;
  }
  if (remoteDisposable) {
    const names = remoteDisposableWorkerNames(inventory);
    if (worker === "gateway") {
      const limitNamespaces = remoteDisposableRateLimitNamespaces(inventory);
      if (!Array.isArray(config.ratelimits) ||
          config.ratelimits.length !== rateLimitBindingNames.length ||
          config.ratelimits.some((limit) => !Object.hasOwn(limitNamespaces, limit.name))) {
        throw new TypeError("Gateway template is missing the exact disposable rate-limit bindings");
      }
      config.ratelimits = config.ratelimits.map((limit) => ({
        ...limit,
        namespace_id: limitNamespaces[limit.name],
      }));
      const controlPlane = config.services?.find((binding) => binding.binding === "CONTROL_PLANE");
      if (!controlPlane) throw new TypeError("Gateway template is missing CONTROL_PLANE");
      controlPlane.service = names.controlPlane;
    }
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}
