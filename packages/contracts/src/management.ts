import { z } from "zod";
import { BuildCatalogSchema, RuntimeMetadataSchema } from "./producer.js";
import { DigestSchema } from "./build.js";
import { ResourceRequirementsSchema } from "./lifecycle.js";
import { PublicOperationSchema, RepositorySnapshotSchema } from "./repository.js";
import { BuildProgressSchema } from "./build-queue.js";
const Id = z.string().min(1).max(128);
export const ConfigurationSelectionSchema = z.strictObject({
  releaseId: Id,
  requestedModules: z.array(Id).max(256),
  resourceProfileId: Id,
  policy: z.enum(["stable", "pinned"]),
});
export const PublicConfigurationRevisionSchema = z.strictObject({
  revisionId: Id,
  instanceId: Id,
  repositoryId: z.number().int().positive().safe(),
  generation: z.number().int().positive().safe(),
  buildKey: DigestSchema,
  buildId: Id,
  selection: ConfigurationSelectionSchema,
  resources: ResourceRequirementsSchema,
  runtimeMetadata: RuntimeMetadataSchema,
  artifactDigest: DigestSchema.nullable(),
  status: z.enum(["building", "admitted", "failed", "superseded"]),
  actorId: z.string().min(1).max(255),
  createdAt: z.number().int().nonnegative().safe(),
});
export const ReleaseSummarySchema = z.strictObject({
  releaseId: Id,
  version: z.string().min(1).max(128),
  imageDigest: DigestSchema,
  catalog: BuildCatalogSchema,
});
export const ReleaseListSchema = z.strictObject({
  releases: z.array(ReleaseSummarySchema).max(50),
});
export const PublicBuildStatusSchema = z.strictObject({
  id: Id,
  buildKey: DigestSchema,
  status: z.enum([
    "reserved",
    "pending",
    "claimed",
    "running",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  progress: BuildProgressSchema.nullable(),
  errorCode: z.string().min(1).max(128).nullable(),
  updatedAt: z.number().int().nonnegative().safe(),
});
export const InstanceDashboardSchema = z.strictObject({
  snapshot: RepositorySnapshotSchema,
  current: PublicConfigurationRevisionSchema.nullable(),
  desired: PublicConfigurationRevisionSchema.nullable(),
  build: PublicBuildStatusSchema.nullable(),
  operations: z.array(PublicOperationSchema).max(50),
  releases: z.array(ReleaseSummarySchema).max(50),
  resourceLimits: ResourceRequirementsSchema.nullable(),
});
export type InstanceDashboard = z.infer<typeof InstanceDashboardSchema>;
export type ReleaseSummary = z.infer<typeof ReleaseSummarySchema>;
