import { z } from "zod";
import { BuildInputSchema, DigestSchema } from "./build.js";
const Identifier = z.string().min(1).max(128);
const Epoch = z.number().int().positive();
const Sequence = z.number().int().positive();
const LeaseToken = z.string().min(32).max(256);
export const BuildProgressSchema = z.strictObject({
  stage: z.enum(["preparing", "building", "publishing"]),
  percent: z.number().min(0).max(100).nullable(),
});
export const BuildClaimSchema = z.strictObject({
  buildId: Identifier,
  buildKey: DigestSchema,
  input: BuildInputSchema,
  attemptId: Identifier,
  attempt: Epoch,
  leaseEpoch: Epoch,
  leaseToken: LeaseToken,
  leaseExpiresAt: z.number().int().positive(),
});
const AttemptShape = {
  buildId: Identifier,
  attemptId: Identifier,
  leaseEpoch: Epoch,
  leaseToken: LeaseToken,
  workerId: Identifier,
  sequence: Sequence,
};
export const BuildClaimRequestSchema = z.strictObject({
  workerId: Identifier,
  leaseSeconds: z.number().int().min(1).max(300),
});
export const BuildHeartbeatRequestSchema = z.strictObject({
  ...AttemptShape,
  leaseSeconds: z.number().int().min(1).max(300),
  progress: BuildProgressSchema.optional(),
});
export const BuildCandidateSchema = z.strictObject({
  candidateRef: z.string().regex(/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/),
  manifestDigest: DigestSchema,
});
const FailureShape = {
  code: z.enum(["BUILD_FAILED", "BUILD_TIMEOUT", "BUILD_CANCELED"]),
  message: z.string().max(256),
  retryable: z.boolean(),
};
export const BuildReportRequestSchema = z.strictObject({
  ...AttemptShape,
  buildKey: DigestSchema,
  result: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("succeeded"), ...BuildCandidateSchema.shape }),
    z.strictObject({ kind: z.literal("failed"), ...FailureShape }),
    z.strictObject({ kind: z.literal("canceled"), ...FailureShape }),
  ]),
});
export type BuildClaim = z.infer<typeof BuildClaimSchema>;
export type BuildClaimRequest = z.infer<typeof BuildClaimRequestSchema>;
export type BuildHeartbeatRequest = z.infer<typeof BuildHeartbeatRequestSchema>;
export type BuildReportRequest = z.infer<typeof BuildReportRequestSchema>;
