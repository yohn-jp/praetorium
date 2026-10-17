import { BuildInputSchema } from "@praetorium/contracts";
import { composeBuildServices } from "./build-composition.js";
import { composeReleaseServices } from "./release-composition.js";
import { createScheduledHandler } from "./scheduled.js";
import { createRuntimeIdentityRoutes } from "./runtime-identity-routes.js";
import { createRuntimeBindingMetadataReader } from "./runtime-binding.js";
import { createRuntimeGitCredentialRoutes } from "./runtime-git-credential-routes.js";
import { D1RuntimeGitCredentialStore } from "@praetorium/persistence/d1";
import {
  createCredentialRetirementBarrier,
  type CredentialRetirementBinding,
} from "./credential-retirement.js";
import { newInstanceId, newOperationId } from "@praetorium/domain";
import { InstanceService, RepositoryRegistryService } from "@praetorium/application/instances";
import { OperationService } from "@praetorium/application/operations";
import { D1PlatformStore, type D1Database } from "@praetorium/persistence/d1";
import { createControlCredentialIssuer } from "./control-credentials.js";
import {
  readAdmittedPersistence,
  resolveAdmittedRuntime,
  resolveRuntimeContext,
} from "./runtime-context.js";
import { createControlPlaneApp, equalSecret, boundedJson } from "./app.js";
export interface CoordinatorNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export interface ControlPlaneEnv {
  CONTROL_PLANE_DB: D1Database;
  REPOSITORY_COORDINATOR: CoordinatorNamespace;
  CONTROL_PLANE_GATEWAY_AUTH: string;
  PROVISIONER_AUTH_TOKEN?: string;
  PROVISIONER_WORKER_ID?: string;
  PROVISIONER_CLUSTER_ID?: string;
  GATEWAY_ORIGIN?: string;
  INSTANCE_HOST_SUFFIX?: string;
  CONTROL_PLANE_ORIGIN?: string;
  RUNTIME_REGISTRY_HOST?: string;
  GIT_CREDENTIAL_BROKER_LOCATOR?: string;
  RUNTIME_CONTROL_SIGNING_KEY?: string;
  RUNTIME_IDENTITY_SIGNING_KEY?: string;
  GATEWAY_SERVICE?: CredentialRetirementBinding;
  RUNTIME_CREDENTIAL_RETIREMENT_AUTH?: string;
  BUILD_POLICY_JSON?: string;
  REGISTRY_PULL_CREDENTIAL?: string;
  BUILD_WORKER_AUTH_TOKEN?: string;
  BUILD_WORKER_ID?: string;
  RELEASE_POLICY_JSON?: string;
  RELEASE_OPERATOR_TOKEN?: string;
}
function composeServices(env: ControlPlaneEnv) {
  const store = new D1PlatformStore(env.CONTROL_PLANE_DB);
  const registry = new RepositoryRegistryService(store, () =>
    newInstanceId(Date.now(), crypto.getRandomValues(new Uint8Array(10))),
  );
  const instances = new InstanceService(store, () =>
    newOperationId(Date.now(), crypto.getRandomValues(new Uint8Array(10))),
  );
  const operations = new OperationService(store, () => randomCapability());
  const buildServices = env.BUILD_POLICY_JSON
    ? composeBuildServices(
        env.CONTROL_PLANE_DB,
        env.BUILD_POLICY_JSON,
        env.REGISTRY_PULL_CREDENTIAL,
      )
    : undefined;
  const controlIssuer = env.RUNTIME_CONTROL_SIGNING_KEY
    ? createControlCredentialIssuer({
        operations,
        instances,
        issuerOrigin: required(env.CONTROL_PLANE_ORIGIN),
        signingKey: JSON.parse(env.RUNTIME_CONTROL_SIGNING_KEY),
        hasActiveOperation: async (instanceId) =>
          Boolean(
            await env.CONTROL_PLANE_DB.prepare(
              "SELECT 1 AS active FROM operations WHERE instance_id=? AND status IN ('pending','claimed','running') LIMIT 1",
            )
              .bind(instanceId)
              .first(),
          ),
      })
    : undefined;
  const releases =
    env.RELEASE_POLICY_JSON && buildServices
      ? composeReleaseServices({
          db: env.CONTROL_PLANE_DB,
          builds: buildServices,
          instances,
          operations,
          policyJson: env.RELEASE_POLICY_JSON,
          operatorToken: required(env.RELEASE_OPERATOR_TOKEN),
        })
      : undefined;
  const app = createControlPlaneApp({
    ...(env.RUNTIME_CREDENTIAL_RETIREMENT_AUTH
      ? { credentialRetirementSecret: env.RUNTIME_CREDENTIAL_RETIREMENT_AUTH }
      : {}),
    runtimeCredentials: createRuntimeGitCredentialRoutes({
      db: env.CONTROL_PLANE_DB,
      runtimeBindings: createRuntimeBindingMetadataReader({ db: env.CONTROL_PLANE_DB }),
      credentials: new D1RuntimeGitCredentialStore(env.CONTROL_PLANE_DB),
    }),
    ...(env.RUNTIME_IDENTITY_SIGNING_KEY
      ? {
          runtimeIdentity: createRuntimeIdentityRoutes({
            db: env.CONTROL_PLANE_DB,
            runtimeBindings: createRuntimeBindingMetadataReader({ db: env.CONTROL_PLANE_DB }),
            operations,
            signingKey: JSON.parse(env.RUNTIME_IDENTITY_SIGNING_KEY),
            issuerOrigin: required(env.CONTROL_PLANE_ORIGIN),
            workerId: required(env.PROVISIONER_WORKER_ID),
            clusterId: required(env.PROVISIONER_CLUSTER_ID),
          }),
        }
      : {}),
    ...(releases
      ? {
          operatorAdmission: releases.operatorReleaseAdmission,
          operatorToken: required(env.RELEASE_OPERATOR_TOKEN),
        }
      : {}),
    ...(controlIssuer ? { controlJwks: () => controlIssuer.jwks() } : {}),
    registry,
    instances,
    webhook: { db: env.CONTROL_PLANE_DB, gatewaySecret: env.CONTROL_PLANE_GATEWAY_AUTH },
    operationAdmin: { db: env.CONTROL_PLANE_DB, instances, operations },
    ...(buildServices ? { configuration: { configuration: buildServices.configurations } } : {}),
    management: {
      db: env.CONTROL_PLANE_DB,
      instances,
      operations,
      ...(buildServices ? { resourceLimits: buildServices.resourceLimits } : {}),
    },
    ...(buildServices && env.BUILD_WORKER_AUTH_TOKEN
      ? {
          builds: {
            queue: buildServices.builds,
            serviceToken: env.BUILD_WORKER_AUTH_TOKEN,
            workerId: required(env.BUILD_WORKER_ID),
          },
        }
      : {}),
    ...(controlIssuer && env.PROVISIONER_AUTH_TOKEN
      ? {
          idle: {
            db: env.CONTROL_PLANE_DB,
            store,
            credentialIssuer: controlIssuer,
            workerId: required(env.PROVISIONER_WORKER_ID),
            clusterId: required(env.PROVISIONER_CLUSTER_ID),
            now: Date.now,
            newOperationId: () =>
              newOperationId(Date.now(), crypto.getRandomValues(new Uint8Array(10))),
            resolveCurrentRuntime: async (snapshot, revision) =>
              resolveAdmittedRuntime(
                snapshot,
                revision,
                snapshot.instance.observedRuntimeEpoch,
                {
                  gatewayOrigin: required(env.GATEWAY_ORIGIN),
                  controlPlaneOrigin: required(env.CONTROL_PLANE_ORIGIN),
                  instanceHostSuffix: required(env.INSTANCE_HOST_SUFFIX),
                  registryHost: required(env.RUNTIME_REGISTRY_HOST),
                  credentialBrokerLocator: required(env.GIT_CREDENTIAL_BROKER_LOCATOR),
                  defaultBranchPolicy: "revalidate-current-default",
                },
                buildServices
                  ? await readAdmittedPersistence(revision, buildServices.registry)
                  : undefined,
              ),
          },
        }
      : {}),
    gatewaySecret: env.CONTROL_PLANE_GATEWAY_AUTH,
    ...(env.PROVISIONER_AUTH_TOKEN
      ? {
          provisioner: {
            operations,
            retireCredentials: createCredentialRetirementBarrier({
              db: env.CONTROL_PLANE_DB,
              ...(env.GATEWAY_SERVICE ? { gateway: env.GATEWAY_SERVICE } : {}),
              ...(env.RUNTIME_CREDENTIAL_RETIREMENT_AUTH
                ? { serviceSecret: env.RUNTIME_CREDENTIAL_RETIREMENT_AUTH }
                : {}),
            }),
            secret: env.PROVISIONER_AUTH_TOKEN,
            workerId: required(env.PROVISIONER_WORKER_ID),
            clusterId: required(env.PROVISIONER_CLUSTER_ID),
            now: Date.now,
            ...(controlIssuer
              ? {
                  issueControlCredential: (input: unknown) =>
                    controlIssuer.issue(input as Parameters<typeof controlIssuer.issue>[0]),
                }
              : {}),
            resolveRuntimeContext: async (claim) => {
              if (claim.operation.kind !== "stop") {
                const revision = claim.deploymentRevision;
                if (!buildServices || !revision?.artifact)
                  throw new Error("Artifact admission policy unavailable");
                const row = await env.CONTROL_PLANE_DB.prepare(
                  "SELECT build_input_json FROM builds WHERE build_id=? AND status='succeeded'",
                )
                  .bind(revision.buildId)
                  .first<{ build_input_json: string }>();
                if (!row) throw new Error("Target build is not admitted");
                await buildServices.admission.verifyCandidate(
                  {
                    statement: revision.artifact.statement,
                    signature: revision.artifact.signature,
                  },
                  BuildInputSchema.parse(JSON.parse(row.build_input_json)),
                );
              }
              const persistenceEntries = buildServices
                ? await Promise.all(
                    [claim.currentDeploymentRevision, claim.deploymentRevision].map(
                      async (revision) => {
                        const persistence = await readAdmittedPersistence(
                          revision,
                          buildServices.registry,
                        );
                        return revision && persistence
                          ? ([revision.revisionId, persistence] as const)
                          : null;
                      },
                    ),
                  )
                : [];
              return resolveRuntimeContext(
                claim,
                {
                  gatewayOrigin: required(env.GATEWAY_ORIGIN),
                  controlPlaneOrigin: required(env.CONTROL_PLANE_ORIGIN),
                  instanceHostSuffix: required(env.INSTANCE_HOST_SUFFIX),
                  registryHost: required(env.RUNTIME_REGISTRY_HOST),
                  credentialBrokerLocator: required(env.GIT_CREDENTIAL_BROKER_LOCATOR),
                  defaultBranchPolicy: "revalidate-current-default",
                },
                new Map(persistenceEntries.filter((entry) => entry !== null)),
              );
            },
          },
        }
      : {}),
  });
  return { app, releases, buildServices };
}
export function composeControlPlane(env: ControlPlaneEnv) {
  return composeServices(env).app;
}
function required(value: string | undefined): string {
  if (!value) throw new Error("Required service binding missing");
  return value;
}
function randomCapability(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
/** This DO serializes repository transitions only; all desired state stays in D1. */
export class RepositoryCoordinator {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    _state: unknown,
    private readonly env: ControlPlaneEnv,
  ) {}
  fetch(request: Request): Promise<Response> {
    // Serialize requests without holding the DO initialization gate over registry I/O.
    // D1 transactions and expected-generation fences remain authoritative after a restart.
    const response = this.pending.then(() => composeControlPlane(this.env).fetch(request));
    this.pending = response.then(
      () => undefined,
      () => undefined,
    );
    return response;
  }
}
export default {
  scheduled: createScheduledHandler<ControlPlaneEnv>(async (env) => {
    await new D1RuntimeGitCredentialStore(env.CONTROL_PLANE_DB).purgeExpired(Date.now(), 64);
    const { releases, buildServices } = composeServices(env);
    if (buildServices) await buildServices.planCacheMaintenance(new Date());
    if (!releases)
      throw new Error("T11 release policy and isolated operator/canary bindings unavailable");
    return releases.scheduled;
  }),
  async fetch(request: Request, env: ControlPlaneEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      const coordinated =
        request.method === "POST" &&
        (/^\/v1\/repositories\/resolve$/.test(url.pathname) ||
          /^\/v1\/instances\/[^/]+\/(?:desired|configuration)(?:\/preview)?$/.test(url.pathname));
      if (coordinated) {
        if (
          !env.CONTROL_PLANE_GATEWAY_AUTH ||
          !(await equalSecret(
            request.headers.get("X-Control-Plane-Gateway-Auth") ?? "",
            env.CONTROL_PLANE_GATEWAY_AUTH,
          ))
        )
          return Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
        let repositoryId: number | undefined;
        if (url.pathname === "/v1/repositories/resolve") {
          const body = await boundedJson(request.clone());
          repositoryId = (body as { repositoryId?: number }).repositoryId;
          if (!Number.isSafeInteger(repositoryId) || repositoryId! <= 0)
            return Response.json({ error: { code: "INVALID_REQUEST" } }, { status: 400 });
        } else {
          const instanceId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
          const snapshot = await new D1PlatformStore(env.CONTROL_PLANE_DB).getByInstanceId(
            instanceId,
          );
          if (!snapshot)
            return Response.json({ error: { code: "REPOSITORY_NOT_FOUND" } }, { status: 404 });
          repositoryId = snapshot.binding.repositoryId;
        }
        const id = env.REPOSITORY_COORDINATOR.idFromName(`repository:${repositoryId}`);
        return await env.REPOSITORY_COORDINATOR.get(id).fetch(request);
      }
      return await composeControlPlane(env).fetch(request);
    } catch {
      return Response.json(
        { error: { code: "UPSTREAM_UNAVAILABLE" } },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  },
};
