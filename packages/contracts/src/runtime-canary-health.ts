import { z } from "zod";
import { RepositoryIdSchema } from "./access.js";

const Identifier = z.string().min(1).max(128);
const Timestamp = z.number().int().nonnegative().safe();

/** Authenticated point lookup; the response is a scheduling hint, not stop authority. */
export const RuntimeCanaryHealthDueRequestSchema = z.strictObject({
  workerId: Identifier,
  clusterId: Identifier,
  instanceId: Identifier,
  repositoryId: RepositoryIdSchema,
  expectedGeneration: z.number().int().nonnegative().safe(),
  expectedRuntimeEpoch: z.number().int().positive().safe(),
});

export const RuntimeCanaryHealthDueResponseSchema = z
  .strictObject({
    active: z.boolean(),
    nextCheckAt: Timestamp.nullable(),
    sampleDueAt: Timestamp.nullable(),
    healthOperationId: Identifier.nullable(),
  })
  .refine(
    (value) =>
      value.active
        ? value.nextCheckAt !== null &&
          value.healthOperationId !== null &&
          (value.sampleDueAt === null || value.sampleDueAt <= value.nextCheckAt)
        : value.nextCheckAt === null &&
          value.sampleDueAt === null &&
          value.healthOperationId === null,
    { message: "Canary health hints must identify an active workflow and its exact due token" },
  );

export type RuntimeCanaryHealthDueRequest = z.infer<typeof RuntimeCanaryHealthDueRequestSchema>;
export type RuntimeCanaryHealthDueResponse = z.infer<typeof RuntimeCanaryHealthDueResponseSchema>;
