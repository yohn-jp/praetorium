import { createScriptoriumCatalogResolverRegistry } from "@praetorium/scriptorium";
import { BuildInputSchema } from "@praetorium/contracts";
import { createRuntimeHealthRoutes } from "./runtime-health-routes.js";
import { createProvisionerRuntimeAuthProbeRoutes } from "./runtime-auth-probe.js";
import { createProvisionerHistoryDrainGrantRoutes } from "./runtime-history-drain-grant.js";
import { composeBuildServices } from "./build-composition.js";
import { composeReleaseServices } from "./release-composition.js";
import { D1SourceReleaseBuildQueue, createSourceReleaseOperatorRoutes, createSourceReleaseWorkerRoutes } from "./source-release-builds.js";
import { metadataFailureReason } from "./http-failure.js";
import { progressProducedSourceReleases } from "./source-release-progression.js";
import { createScheduledHandler } from "./scheduled.js";
import type { ExecutionContext } from "hono";
import { notifyWorkAvailable, type WorkNotificationEnv } from "./work-notifications.js";
import { createRuntimeIdentityRoutes } from "./runtime-identity-routes.js";
import { publishRuntimeAuthority } from "./runtime-authority-transition.js";
import { createRuntimeAuthorityRecovery } from "./runtime-authority-recovery.js";
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
export interface ControlPlaneEnv extends WorkNotificationEnv {
  CONTROL_PLANE_DB: D1Database;
  REPOSITORY_COORDINATOR: CoordinatorNamespace;
  CONTROL_PLANE_GATEWAY_AUTH: string;
  ADMIN_CONTROL_PLANE_AUTH?: string;
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
  const notifyWork = (kind: "build" | "operation", instanceId?: string) =>
    notifyWorkAvailable(env, kind, fetch, instanceId);
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
        createScriptoriumCatalogResolverRegistry(),
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
    env.RELEASE_POLICY_JSON && env.RELEASE_OPERATOR_TOKEN && buildServices
      ? composeReleaseServices({
          db: env.CONTROL_PLANE_DB,
          builds: buildServices,
          instances,
          operations,
          policyJson: env.RELEASE_POLICY_JSON,
          operatorToken: required(env.RELEASE_OPERATOR_TOKEN),
          gatewayServiceSecret: required(env.CONTROL_PLANE_GATEWAY_AUTH),
          ...(env.ADMIN_CONTROL_PLANE_AUTH ? {adminServiceSecret: env.ADMIN_CONTROL_PLANE_AUTH} : {}),
          notifyWorkAvailable: notifyWork,
        })
      : undefined;
  const sourceBuilds = releases && env.BUILD_WORKER_AUTH_TOKEN && buildServices?.sourceProducerRepository
    ? new D1SourceReleaseBuildQueue(env.CONTROL_PLANE_DB) : undefined;
  const progressProduced = async () => {
    if(!sourceBuilds || !releases)return;
    await progressProducedSourceReleases({
      queue: sourceBuilds,
      admissionLeaseMs: buildServices!.sourceAdmissionLeaseMs,
      admit: releases.admitSourceRelease,
      progressAdmitted: releases.progressAdmittedSourceRelease,
    });
  };
  const app = createControlPlaneApp({
    notifyWorkAvailable: notifyWork,
    ...(env.GATEWAY_SERVICE && env.PROVISIONER_AUTH_TOKEN
      ? {
          runtimeAuthProbe: createProvisionerRuntimeAuthProbeRoutes({
            db: env.CONTROL_PLANE_DB,
            operations,
            instances,
            runtimeBindings: createRuntimeBindingMetadataReader({ db: env.CONTROL_PLANE_DB }),
            ...(releases ? { canaryProbeActor: releases.canaryProbeActor } : {}),
            gateway: env.GATEWAY_SERVICE,
            gatewaySecret: env.CONTROL_PLANE_GATEWAY_AUTH,
            gatewayOrigin: required(env.GATEWAY_ORIGIN),
            controlPlaneOrigin: required(env.CONTROL_PLANE_ORIGIN),
            instanceHostSuffix: required(env.INSTANCE_HOST_SUFFIX),
            workerId: required(env.PROVISIONER_WORKER_ID),
            clusterId: required(env.PROVISIONER_CLUSTER_ID),
          }),
          runtimeHistoryDrainGrant: createProvisionerHistoryDrainGrantRoutes({
            db: env.CONTROL_PLANE_DB,
            operations,
            instances,
            gateway: env.GATEWAY_SERVICE,
            gatewaySecret: env.CONTROL_PLANE_GATEWAY_AUTH,
            gatewayOrigin: required(env.GATEWAY_ORIGIN),
            workerId: required(env.PROVISIONER_WORKER_ID),
            clusterId: required(env.PROVISIONER_CLUSTER_ID),
            // Verified immutable legacy core/MCP-only artifacts. Their owner
            // GET /api/jobs serializes pending history writes after quiesce;
            // the dedicated route still requires the live operation fence,
            // safe receipt, admitted statement and fresh sole-writer census.
            // See OPERATIONAL-CONVERGENCE-20261025 for the source/OCI evidence.
            legacyDrainArtifacts: [
              {
                platformManifestDigest: "sha256:2d21804e6a3686ff141afc4299259d60c245a3395d312c943a436ef25dd2e6f4",
                producerRevision: "588eddcfff20fa2fc76aa8eae54c9551e0c6048b",
                enabledModuleIds: ["mcp"],
              },
              {
                platformManifestDigest: "sha256:0c46d41281cfec4a25e026f5396ca6a451683acd7bb29335f815359acf07eb5b",
                producerRevision: "95a66c2c985a66bc2d535392dcc450d8c9df18d5",
                enabledModuleIds: [],
              },
            ],
          }),
        }
      : {}),
    ...(env.PROVISIONER_AUTH_TOKEN
      ? {
          runtimeHealth: createRuntimeHealthRoutes({
            db: env.CONTROL_PLANE_DB,
            workerId: required(env.PROVISIONER_WORKER_ID),
            clusterId: required(env.PROVISIONER_CLUSTER_ID),
            ...(releases
              ? { onCanaryHealthRecorded: releases.progressCanaryHealth }
              : {}),
          }),
        }
      : {}),
    ...(env.RUNTIME_CREDENTIAL_RETIREMENT_AUTH
      ? { credentialRetirementSecret: env.RUNTIME_CREDENTIAL_RETIREMENT_AUTH }
      : {}),
    runtimeCredentials: createRuntimeGitCredentialRoutes({
      db: env.CONTROL_PLANE_DB,
      credentials: new D1RuntimeGitCredentialStore(env.CONTROL_PLANE_DB),
    }),
    ...(env.RUNTIME_IDENTITY_SIGNING_KEY
      ? {
          runtimeIdentity: createRuntimeIdentityRoutes({
            db: env.CONTROL_PLANE_DB,
            runtimeBindings: createRuntimeBindingMetadataReader({ db: env.CONTROL_PLANE_DB }),
            signingKey: JSON.parse(env.RUNTIME_IDENTITY_SIGNING_KEY),
            issuerOrigin: required(env.CONTROL_PLANE_ORIGIN),
            workerId: required(env.PROVISIONER_WORKER_ID),
            clusterId: required(env.PROVISIONER_CLUSTER_ID),
          }),
        }
      : {}),
    ...(sourceBuilds ? {
      sourceReleaseOperator: createSourceReleaseOperatorRoutes({
        queue: sourceBuilds,
        operatorActorId: (JSON.parse(required(env.RELEASE_POLICY_JSON)) as {operatorActorId:string}).operatorActorId,
        notifyBuild: async () => { await notifyWork("build"); },
      }),
      sourceReleaseWorker: createSourceReleaseWorkerRoutes({
        queue: sourceBuilds,
        workerId: required(env.BUILD_WORKER_ID),
        serviceToken: required(env.BUILD_WORKER_AUTH_TOKEN),
        verifyProduced: (job, proof) => releases!.sourceProofVerifier.verify(job,proof).then(()=>undefined),
        afterProduced: progressProduced,
      }),
    } : {}),
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
            ...(releases ? { afterAcceptedSuccess: releases.afterAcceptedCanaryBuild } : {}),
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
            ...(releases ? { canaryHealthSchedule: releases.getCanaryHealthSchedule } : {}),
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
    ...(env.ADMIN_CONTROL_PLANE_AUTH ? { adminSecret: env.ADMIN_CONTROL_PLANE_AUTH } : {}),
    ...(env.PROVISIONER_AUTH_TOKEN
      ? {
          provisioner: {
            operations,
            ...(releases
              ? { afterCanaryStopReported: releases.progressCanaryStop }
              : {}),
            publishRuntimeAuthority: (operation, now) => publishRuntimeAuthority(env.CONTROL_PLANE_DB, operation, now),
            recoverRuntimeAuthority: createRuntimeAuthorityRecovery({
              db: env.CONTROL_PLANE_DB,
              operations,
              now: Date.now,
            }),
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
  return { app, releases, buildServices, progressProduced };
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
export interface RepositoryCoordinatorState {
  waitUntil(promise: Promise<unknown>): void;
  readonly props?: unknown;
  readonly exports?: unknown;
}

export class RepositoryCoordinator {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly state: RepositoryCoordinatorState,
    private readonly env: ControlPlaneEnv,
  ) {}
  fetch(request: Request): Promise<Response> {
    // Serialize requests without holding the DO initialization gate over registry I/O.
    // D1 transactions and expected-generation fences remain authoritative after a restart.
    const executionContext: ExecutionContext = {
      waitUntil: (promise) => this.state.waitUntil(promise),
      passThroughOnException() {},
      props: this.state.props,
      ...(this.state.exports === undefined ? {} : { exports: this.state.exports }),
    };
    const response = this.pending.then(() =>
      composeControlPlane(this.env).fetch(request, this.env, executionContext),
    );
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
    // Reuse existing bounded maintenance; no additional polling controller.
    // An optional source feature on a pre-0008 database must not block unrelated maintenance.
    try { await new D1SourceReleaseBuildQueue(env.CONTROL_PLANE_DB).expireDiagnostics(100); }
    catch (error) { if (metadataFailureReason(error) !== "schema_missing") throw error; }
    const composed=composeServices(env);
    await composed.progressProduced();
    return composed.releases?.scheduled ?? null;
  }),
  async fetch(
    request: Request,
    env: ControlPlaneEnv,
    context?: ExecutionContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz")
        return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
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
      return await composeControlPlane(env).fetch(request, env, context);
    } catch {
      return Response.json(
        { error: { code: "UPSTREAM_UNAVAILABLE" } },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  },
};
