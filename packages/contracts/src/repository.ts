import { z } from "zod";
import { RepositoryIdSchema } from "./access.js";
export const RepositoryBindingSchema = z.strictObject({
  repositoryId: RepositoryIdSchema,
  instanceId: z.string().min(1),
  installationId: z.number().int().positive(),
  owner: z.string().min(1),
  name: z.string().min(1),
  authorizationRevision: z.number().int().nonnegative(),
  bindingEpoch: z.number().int().nonnegative(),
  suspended: z.boolean(),
});
export const LogicalInstanceSchema = z.strictObject({
  instanceId: z.string().min(1),
  repositoryId: RepositoryIdSchema,
  generation: z.number().int().nonnegative(),
  runtimeEpoch: z.number().int().nonnegative(),
  desiredState: z.enum(["running", "stopped"]),
  policy: z.enum(["stable", "pinned"]),
  observedGeneration: z.number().int().nonnegative().nullable(),
  currentArtifactDigest: z.string().nullable(),
  desiredArtifactDigest: z.string().nullable(),
});
export type RepositoryBinding = z.infer<typeof RepositoryBindingSchema>;
export type LogicalInstance = z.infer<typeof LogicalInstanceSchema>;

export const InstanceSnapshotSchema = LogicalInstanceSchema.extend({
  observedState: z.enum([
    "absent",
    "starting",
    "ready",
    "stopping",
    "stopped",
    "failed",
    "unknown",
  ]),
  observedRuntimeEpoch: z.number().int().nonnegative().nullable(),
  observedSequence: z.number().int().nonnegative(),
  desiredRevisionId: z.string().nullable(),
  observedRevisionId: z.string().nullable(),
  reservationState: z.enum(["none", "pending", "reserved", "blocked", "released"]),
  reservationId: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export const PublicOperationSchema = z.strictObject({
  id: z.string().min(1),
  instanceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  runtimeEpoch: z.number().int().nonnegative(),
  kind: z.enum(["start", "stop", "redeploy", "update"]),
  status: z.enum(["pending", "claimed", "running", "succeeded", "failed", "blocked"]),
  phase: z.string().min(1).max(128),
  attempt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export const RepositorySnapshotSchema = z.strictObject({
  binding: RepositoryBindingSchema,
  instance: InstanceSnapshotSchema,
});
export const ResolveRepositoryResponseSchema = RepositorySnapshotSchema.extend({
  created: z.boolean(),
});
export const DesiredStateResponseSchema = RepositorySnapshotSchema.extend({
  operation: PublicOperationSchema.nullable(),
  replayed: z.boolean(),
});
export type InstanceSnapshot = z.infer<typeof InstanceSnapshotSchema>;
export type PublicOperation = z.infer<typeof PublicOperationSchema>;
export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>;
