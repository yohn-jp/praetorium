import { z } from "zod";

/** Bounded operator evidence, never a raw producer log or a second queue authority. */
export const SOURCE_DIAGNOSTIC_MAX_BYTES = 8_192;
export const SOURCE_DIAGNOSTIC_REQUEST_MAX_BYTES = 12_288;
export const SOURCE_DIAGNOSTIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const SourceBuildStageSchema = z.enum([
  "unknown", "release_check", "source_checkout", "build_environment",
  "runtime_base", "buildkit", "metadata", "oci_export", "verification", "admission",
]);
export const SourceBuildDiagnosticSchema = z.strictObject({
  stage: SourceBuildStageSchema,
  reason: z.enum(["stage_started", "build_failed", "timeout", "canceled", "source_changed",
    "verification_failed", "infrastructure_unavailable", "completed", "unknown"]),
  summary: z.string().max(1_024),
  // Sanitized bounded excerpt only. Both producer and Control Plane enforce caps.
  excerpt: z.string().max(SOURCE_DIAGNOSTIC_MAX_BYTES).optional(),
  truncated: z.boolean(),
});
export type SourceBuildStage = z.infer<typeof SourceBuildStageSchema>;
export type SourceBuildDiagnostic = z.infer<typeof SourceBuildDiagnosticSchema>;
export const SourceBuildSummarySchema = z.strictObject({
  id: z.string().regex(/^sr_[0-9a-f-]{36}$/u),
  sourceId: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
  releaseId: z.number().int().positive().safe(),
  tag: z.string().max(128), commit: z.string().regex(/^[0-9a-f]{40}$/u),
  version: z.string().max(128),
  state: z.enum(["queued", "building", "produced", "admitted", "failed"]),
  attempt: z.number().int().nonnegative().safe(),
  revision: z.number().int().nonnegative().safe(),
  error: z.string().max(90).nullable(), admittedReleaseId: z.string().max(128).nullable(),
  retryable: z.boolean(),
});
export type SourceBuildSummary = z.infer<typeof SourceBuildSummarySchema>;
export const SourceBuildAttemptSchema = z.strictObject({
  id: z.string().max(160),
  attempt: z.number().int().positive().safe(),
  revision: z.number().int().nonnegative().safe(),
  leaseEpoch: z.number().int().positive().safe(),
  state: z.enum(["building", "produced", "failed", "lease_expired"]),
  stage: SourceBuildStageSchema,
  startedAt: z.number().int().nonnegative().safe(),
  finishedAt: z.number().int().nonnegative().safe().nullable(),
  failureCode: z.string().max(90).nullable(),
  evidence: z.enum(["available", "not_recorded", "expired"]),
  expiresAt: z.number().int().nonnegative().safe().nullable(),
  diagnostic: SourceBuildDiagnosticSchema.nullable(),
});
export type SourceBuildAttempt = z.infer<typeof SourceBuildAttemptSchema>;
export const SourceBuildDetailSchema = z.strictObject({
  job: SourceBuildSummarySchema,
  attempts: z.array(SourceBuildAttemptSchema).max(25),
  nextCursor: z.string().max(128).nullable(),
  evidence: z.enum(["available", "not_recorded", "expired"]),
});
export type SourceBuildDetail = z.infer<typeof SourceBuildDetailSchema>;
