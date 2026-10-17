import path from "node:path";
import { isIP } from "node:net";
import type { BuildKitProviderConfig } from "@praetorium/buildkit";

export type BuildWorkerConfig = {
  workerId: string;
  controlPlaneUrl: string;
  serviceTokenFile: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  reconciliationIntervalMs: number;
  notificationEnabled: boolean;
  notificationHost: string;
  notificationPort: number;
  notificationToken?: string;
  signingKeyFile: string;
  signingKeyId: string;
  registryUrl: string;
  registryAllowInsecureLoopback: boolean;
  registryAllowAnonymousLoopbackPublish: boolean;
  registryPullCredentialFile?: string;
  compositionRepository: string;
  maxImageLayerBytes: number;
  maxImageVerificationMs: number;
  maxRegistryRequestMs: number;
  buildKit: BuildKitProviderConfig;
};

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value || value.trim() !== value || value.length > 4096)
    throw new TypeError("Build worker environment is invalid");
  return value;
}

function absolute(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name);
  if (!path.isAbsolute(value) || value.includes("\0"))
    throw new TypeError("Build worker environment is invalid");
  return value;
}

function integer(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^[0-9]{1,12}$/u.test(raw)) throw new TypeError("Build worker environment is invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError("Build worker environment is invalid");
  return value;
}

function requiredInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  min: number,
  max: number,
): number {
  if (environment[name] === undefined) throw new TypeError("Build worker environment is invalid");
  return integer(environment, name, min, min, max);
}

function booleanFlag(environment: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new TypeError("Build worker environment is invalid");
}

function baseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Build worker environment is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Build worker environment is invalid");
  }
  return url.origin;
}

function registryUrl(value: string, allowInsecureLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Build worker environment is invalid");
  }
  if (
    !url.host ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(allowInsecureLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1"))
  ) {
    throw new TypeError("Build worker environment is invalid");
  }
  return url.origin;
}

function repositoryPath(value: string): string {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(value)) {
    throw new TypeError("Build worker environment is invalid");
  }
  return value;
}

export function readBuildWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BuildWorkerConfig {
  const insecureLoopbackValue = environment.PRAETORIUM_BUILD_ALLOW_INSECURE_LOOPBACK_REGISTRY;
  if (insecureLoopbackValue !== undefined && insecureLoopbackValue !== "1") {
    throw new TypeError("Build worker environment is invalid");
  }
  const anonymousLoopbackPublishValue = environment.PRAETORIUM_BUILD_ALLOW_ANONYMOUS_LOOPBACK_PUBLISH;
  if (anonymousLoopbackPublishValue !== undefined && anonymousLoopbackPublishValue !== "1") {
    throw new TypeError("Build worker environment is invalid");
  }
  const registryAllowInsecureLoopback = insecureLoopbackValue === "1";
  const registryUrlValue = environment.PRAETORIUM_BUILD_REGISTRY_URL ?? "https://ghcr.io";
  let parsedRegistryUrl: URL;
  try {
    parsedRegistryUrl = new URL(registryUrlValue);
  } catch {
    throw new TypeError("Build worker environment is invalid");
  }
  if (registryAllowInsecureLoopback && (parsedRegistryUrl.protocol !== "http:" || parsedRegistryUrl.hostname !== "127.0.0.1")) {
    throw new TypeError("Build worker environment is invalid");
  }
  if (
    anonymousLoopbackPublishValue === "1" &&
    parsedRegistryUrl.hostname !== "127.0.0.1"
  ) {
    throw new TypeError("Build worker environment is invalid");
  }
  const registryAllowAnonymousLoopbackPublish =
    anonymousLoopbackPublishValue === "1" || registryAllowInsecureLoopback;
  const leaseSeconds = integer(environment, "PRAETORIUM_BUILD_LEASE_SECONDS", 120, 15, 300);
  const heartbeatIntervalMs = integer(
    environment,
    "PRAETORIUM_BUILD_HEARTBEAT_MS",
    15_000,
    250,
    60_000,
  );
  if (heartbeatIntervalMs >= leaseSeconds * 1000)
    throw new TypeError("Build worker environment is invalid");
  const notificationEnabled = booleanFlag(
    environment,
    "PRAETORIUM_BUILD_WORK_NOTIFICATION_ENABLED",
  );
  const notificationHost = environment.PRAETORIUM_BUILD_WORK_NOTIFICATION_HOST ?? "127.0.0.1";
  const notificationToken = environment.PRAETORIUM_BUILD_WORK_NOTIFICATION_TOKEN;
  if (
    isIP(notificationHost) === 0 ||
    (notificationToken !== undefined &&
      (notificationToken.length < 32 ||
        notificationToken.length > 4096 ||
        /[^\x21-\x7e]/u.test(notificationToken))) ||
    (notificationEnabled && notificationToken === undefined)
  ) {
    throw new TypeError("Build worker environment is invalid");
  }

  return {
    workerId: required(environment, "PRAETORIUM_BUILD_WORKER_ID"),
    controlPlaneUrl: baseUrl(required(environment, "PRAETORIUM_CONTROL_PLANE_URL")),
    serviceTokenFile: absolute(environment, "PRAETORIUM_BUILD_SERVICE_TOKEN_FILE"),
    requestTimeoutMs: integer(environment, "PRAETORIUM_BUILD_HTTP_TIMEOUT_MS", 10_000, 100, 60_000),
    maxResponseBytes: integer(
      environment,
      "PRAETORIUM_BUILD_HTTP_MAX_RESPONSE_BYTES",
      262_144,
      1024,
      1_048_576,
    ),
    leaseSeconds,
    heartbeatIntervalMs,
    reconciliationIntervalMs: integer(
      environment,
      "PRAETORIUM_BUILD_RECONCILIATION_INTERVAL_MS",
      300_000,
      60_000,
      300_000,
    ),
    notificationEnabled,
    notificationHost,
    notificationPort: integer(
      environment,
      "PRAETORIUM_BUILD_WORK_NOTIFICATION_PORT",
      8788,
      1,
      65_535,
    ),
    ...(notificationToken === undefined ? {} : { notificationToken }),
    signingKeyFile: absolute(environment, "PRAETORIUM_BUILD_SIGNING_KEY_FILE"),
    signingKeyId: required(environment, "PRAETORIUM_BUILD_SIGNING_KEY_ID"),
    registryUrl: registryUrl(registryUrlValue, registryAllowInsecureLoopback),
    registryAllowInsecureLoopback,
    registryAllowAnonymousLoopbackPublish,
    ...(environment.PRAETORIUM_BUILD_REGISTRY_PULL_CREDENTIAL_FILE === undefined
      ? {}
      : {
          registryPullCredentialFile: absolute(
            environment,
            "PRAETORIUM_BUILD_REGISTRY_PULL_CREDENTIAL_FILE",
          ),
        }),
    compositionRepository: repositoryPath(
      required(environment, "PRAETORIUM_BUILD_COMPOSITION_REPOSITORY"),
    ),
    maxImageLayerBytes: requiredInteger(
      environment,
      "PRAETORIUM_BUILD_MAX_IMAGE_LAYER_BYTES",
      1,
      16 * 1024 ** 3,
    ),
    maxImageVerificationMs: requiredInteger(
      environment,
      "PRAETORIUM_BUILD_MAX_IMAGE_VERIFICATION_MS",
      1000,
      15 * 60 * 1000,
    ),
    maxRegistryRequestMs: requiredInteger(
      environment,
      "PRAETORIUM_BUILD_MAX_REGISTRY_REQUEST_MS",
      100,
      60_000,
    ),
    buildKit: {
      address: required(environment, "PRAETORIUM_BUILDKIT_ADDRESS"),
      tlsServerName: required(environment, "PRAETORIUM_BUILDKIT_TLS_SERVER_NAME"),
      tlsCaFile: absolute(environment, "PRAETORIUM_BUILDKIT_TLS_CA_FILE"),
      tlsCertFile: absolute(environment, "PRAETORIUM_BUILDKIT_TLS_CERT_FILE"),
      tlsKeyFile: absolute(environment, "PRAETORIUM_BUILDKIT_TLS_KEY_FILE"),
      buildctlPath: absolute(environment, "PRAETORIUM_BUILDKIT_BUILDCTL_PATH"),
      buildkitRepository: required(environment, "PRAETORIUM_BUILDKIT_FRONTEND_REPOSITORY"),
      outputRepository: required(environment, "PRAETORIUM_BUILDKIT_OUTPUT_REPOSITORY"),
      dockerConfigDirectory: absolute(environment, "PRAETORIUM_BUILDKIT_DOCKER_CONFIG_DIRECTORY"),
      temporaryDirectory: absolute(environment, "PRAETORIUM_BUILDKIT_TEMPORARY_DIRECTORY"),
      maxBuildInputBytes: integer(
        environment,
        "PRAETORIUM_BUILDKIT_MAX_INPUT_BYTES",
        65_536,
        1,
        65_536,
      ),
      maxProgressBytes: integer(
        environment,
        "PRAETORIUM_BUILDKIT_MAX_PROGRESS_BYTES",
        8 * 1024 * 1024,
        1024,
        16 * 1024 * 1024,
      ),
      buildTimeoutMs: integer(
        environment,
        "PRAETORIUM_BUILDKIT_TIMEOUT_MS",
        30 * 60 * 1000,
        1000,
        24 * 60 * 60 * 1000,
      ),
      safePath: required(environment, "PRAETORIUM_BUILDKIT_SAFE_PATH"),
      allowInsecureLoopbackRegistry: registryAllowAnonymousLoopbackPublish,
    },
  };
}
