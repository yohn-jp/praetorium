import { Hono } from "hono";
import { z } from "zod";
import {
  InstanceDashboardSchema,
  ReleaseListSchema,
  PublicOperationSchema,
  PublicBuildStatusSchema,
  type ResourceRequirements,
} from "@praetorium/contracts";
import { ReleaseCandidateSchema } from "@praetorium/application/releases";
import type { InstanceService } from "@praetorium/application/instances";
import type { OperationService } from "@praetorium/application/operations";
import { D1ConfigurationStore, type D1Database } from "@praetorium/persistence/d1";
import { publicOperation } from "./app.js";
const Id = z.string().min(1).max(128);
export interface ManagementDependencies {
  db: D1Database;
  instances: InstanceService;
  operations: OperationService;
  resourceLimits?: ResourceRequirements;
}
/** All responses are bounded metadata projections; service authentication is mounted by the app. */
export function createManagementRoutes(deps: ManagementDependencies) {
  const app = new Hono();
  const configurationStore = new D1ConfigurationStore(deps.db);
  const releases = async () => {
    const rows = await deps.db
      .prepare(
        "SELECT candidate_json FROM release_candidates WHERE status='available' ORDER BY created_at DESC, release_id DESC LIMIT 50",
      )
      .all<{ candidate_json: string }>();
    return (rows.results ?? []).map((row) => {
      const release = ReleaseCandidateSchema.parse(JSON.parse(row.candidate_json));
      return {
        releaseId: release.id,
        version: release.version,
        imageDigest: release.imageDigest,
        catalog: release.catalog,
      };
    });
  };
  app.get("/v1/releases", async (c) =>
    c.json(ReleaseListSchema.parse({ releases: await releases() })),
  );
  app.get("/v1/operations/:operationId", async (c) => {
    const op = await deps.operations.getById(Id.parse(c.req.param("operationId")));
    return op
      ? c.json(PublicOperationSchema.parse(publicOperation(op)))
      : c.json({ error: { code: "OPERATION_NOT_FOUND" } }, 404);
  });
  app.get("/v1/instances/:instanceId/dashboard", async (c) => {
    const instanceId = Id.parse(c.req.param("instanceId"));
    const snapshot = await deps.instances.getByInstanceId(instanceId);
    if (!snapshot) return c.json({ error: { code: "REPOSITORY_NOT_FOUND" } }, 404);
    const { instance } = snapshot;
    const [current, desired, releaseList, operationRows] = await Promise.all([
      instance.observedRevisionId
        ? configurationStore.getRevision(instance.observedRevisionId)
        : null,
      instance.desiredRevisionId
        ? configurationStore.getRevision(instance.desiredRevisionId)
        : null,
      releases(),
      deps.db
        .prepare(
          "SELECT operation_id FROM operations WHERE instance_id=? ORDER BY created_at DESC, operation_id DESC LIMIT 50",
        )
        .bind(instanceId)
        .all<{ operation_id: string }>(),
    ]);
    const operations = (
      await Promise.all(
        (operationRows.results ?? []).map((row) => deps.operations.getById(row.operation_id)),
      )
    )
      .filter((op) => op !== null)
      .map(publicOperation);
    const row = desired
      ? await deps.db
          .prepare(
            "SELECT build_id,build_key,status,progress_json,failure_json,updated_at FROM builds WHERE build_id=?",
          )
          .bind(desired.buildId)
          .first<{
            build_id: string;
            build_key: string;
            status: string;
            progress_json: string | null;
            failure_json: string | null;
            updated_at: number;
          }>()
      : null;
    const failure: unknown = row?.failure_json ? JSON.parse(row.failure_json) : null;
    const failureCode =
      typeof failure === "object" &&
      failure !== null &&
      "code" in failure &&
      typeof failure.code === "string" &&
      /^[A-Z0-9_]{1,128}$/.test(failure.code)
        ? failure.code
        : row?.status === "failed"
          ? "BUILD_FAILED"
          : null;
    const build = row
      ? PublicBuildStatusSchema.parse({
          id: row.build_id,
          buildKey: row.build_key,
          status: row.status,
          progress: row.progress_json ? JSON.parse(row.progress_json) : null,
          errorCode: failureCode,
          updatedAt: row.updated_at,
        })
      : null;
    return c.json(
      InstanceDashboardSchema.parse({
        snapshot,
        current,
        desired,
        build,
        operations,
        releases: releaseList,
        resourceLimits: deps.resourceLimits ?? null,
      }),
    );
  });
  return app;
}
