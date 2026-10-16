import { setTimeout as delay } from "node:timers/promises";
import { OperationServiceHttpClient } from "./operation-client.js";
import { ProvisionerMetrics } from "./metrics.js";
import { HealthServer } from "./health.js";
import { JsonLogger, ProvisionerWorker } from "./worker.js";
import { readProvisionerCredential } from "./credentials.js";
import { LifecycleProvisionerExecutor } from "./lifecycle-executor.js";
import { DEFAULT_IDLE_TIMEOUT_MS } from "@praetorium/application/lifecycle";
import { ProvisionerIdleController } from "./idle-controller.js";
import {
  UnavailableRuntimeAssignmentTransport,
  UnavailableRuntimeAuthAcceptanceProbe,
} from "./scriptorium-control-client.js";
import type { InClusterRuntimeOptions } from "./kubernetes-lifecycle-adapter.js";

interface ProvisionerConfig {
  readonly controlPlaneUrl: string;
  readonly credentialPath: string;
  readonly workerId: string;
  readonly clusterId: string;
  readonly runtime: InClusterRuntimeOptions;
  readonly healthPort: number;
  readonly idleTimeoutMs: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value.length === 0 || value.length > 1024) {
    throw new TypeError(`missing provisioner configuration: ${key}`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback?: number): number {
  const raw = env[key];
  if (raw === undefined && fallback !== undefined) return fallback;
  if (raw === undefined || !/^\d+$/u.test(raw))
    throw new TypeError(`invalid provisioner configuration: ${key}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`invalid provisioner configuration: ${key}`);
  return value;
}

export function loadProvisionerConfig(env: NodeJS.ProcessEnv = process.env): ProvisionerConfig {
  const controlPlaneUrl = required(env, "PROVISIONER_CONTROL_PLANE_URL");
  const url = new URL(controlPlaneUrl);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new TypeError("invalid provisioner Control Plane URL");
  const clusterId = required(env, "PROVISIONER_CLUSTER_ID");
  if (!/^clu_[0-9A-HJKMNP-TV-Z]{26}$/u.test(clusterId))
    throw new TypeError("invalid provisioner cluster ID");
  const namespacePrefix = required(env, "PROVISIONER_NAMESPACE_PREFIX");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/u.test(namespacePrefix)) {
    throw new TypeError("invalid runtime namespace prefix");
  }
  const controlNamespace = required(env, "PROVISIONER_CONTROL_NAMESPACE");
  const controlService = required(env, "PROVISIONER_CONTROL_SERVICE");
  if (controlNamespace !== "praetorium-system" || controlService !== "provisioner") {
    throw new TypeError("runtime control network identity must be praetorium-system/provisioner");
  }
  return {
    controlPlaneUrl: controlPlaneUrl.replace(/\/+$/u, ""),
    credentialPath: required(env, "PROVISIONER_CREDENTIAL_PATH"),
    workerId: required(env, "PROVISIONER_WORKER_ID"),
    clusterId,
    healthPort: positiveInteger(env, "PROVISIONER_HEALTH_PORT", 8080),
    idleTimeoutMs: positiveInteger(env, "PROVISIONER_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS),
    runtime: {
      namespacePrefix,
      clusterId,
      ingressNamespace: required(env, "PROVISIONER_INGRESS_NAMESPACE"),
      instanceAccessNamespace: required(env, "PROVISIONER_INSTANCE_ACCESS_NAMESPACE"),
      instanceAccessService: required(env, "PROVISIONER_INSTANCE_ACCESS_SERVICE"),
      controlNamespace: "praetorium-system",
      controlService: "provisioner",
      maximumResources: {
        cpuMilli: positiveInteger(env, "PROVISIONER_MAX_CPU_MILLI"),
        memoryMiB: positiveInteger(env, "PROVISIONER_MAX_MEMORY_MIB"),
        ephemeralStorageMiB: positiveInteger(env, "PROVISIONER_MAX_EPHEMERAL_STORAGE_MIB"),
      },
      maxCapacityAgeMs: positiveInteger(env, "PROVISIONER_MAX_CAPACITY_AGE_MS"),
    },
  };
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  while (!signal.aborted) await delay(60_000, undefined, { signal }).catch(() => undefined);
}

async function main(): Promise<void> {
  const config = loadProvisionerConfig();
  const credential = await readProvisionerCredential(config.credentialPath);
  const metrics = new ProvisionerMetrics();
  const logger = new JsonLogger();
  const operations = new OperationServiceHttpClient({
    baseUrl: config.controlPlaneUrl,
    credential,
  });
  const executor = new LifecycleProvisionerExecutor({
    operations,
    workerId: config.workerId,
    runtime: config.runtime,
    // The producer assignment ABI and S02 grant-probe transport are not yet
    // available. The worker keeps readiness false and claims no operations.
    authProbe: new UnavailableRuntimeAuthAcceptanceProbe(),
    assignmentTransport: new UnavailableRuntimeAssignmentTransport(),
  });
  const shutdown = new AbortController();
  let live = true;
  let ready = false;
  const health = new HealthServer({
    metrics,
    port: config.healthPort,
    isLive: () => live,
    isReady: () => ready,
  });
  const stop = () => {
    live = false;
    ready = false;
    shutdown.abort();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await health.start();
  logger.info("provisioner_started", { clusterId: config.clusterId });
  try {
    if (!executor.canExecute) {
      metrics.increment("runtime_capability_gate_closed");
      logger.warn("provisioner_capability_gate_closed", {
        code: "runtime_producer_contract_incomplete",
      });
      await waitForAbort(shutdown.signal);
      return;
    }
    const worker = new ProvisionerWorker({
      operations,
      executor,
      workerId: config.workerId,
      clusterId: config.clusterId,
      metrics,
      logger,
      onReadyChange: (value) => {
        ready = value;
      },
    });
    const idleController = new ProvisionerIdleController({
      operations,
      workerId: config.workerId,
      clusterId: config.clusterId,
      runtime: config.runtime,
      idleTimeoutMs: config.idleTimeoutMs,
      metrics,
      logger,
    });
    try {
      await Promise.all([worker.run(shutdown.signal), idleController.run(shutdown.signal)]);
    } catch (error) {
      shutdown.abort(error);
      throw error;
    }
  } finally {
    ready = false;
    live = false;
    await health.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "provisioner_start_failed",
      code:
        error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(error.message)
          ? error.message
          : error instanceof Error
            ? error.name
            : "startup_error",
      at: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
