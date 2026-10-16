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
