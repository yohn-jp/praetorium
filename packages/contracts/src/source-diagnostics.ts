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

const REASON_SUMMARIES: Record<SourceBuildDiagnostic["reason"], string> = {
  stage_started: "Execution stage started.",
  build_failed: "BuildKit reported a build failure. Inspect the sanitized diagnostic excerpt when available.",
  timeout: "The execution stage exceeded its time budget.",
  canceled: "The execution stage was canceled.",
  source_changed: "The published source identity no longer matches the accepted release.",
  verification_failed: "Source, artifact, or producer evidence verification failed.",
  infrastructure_unavailable: "A required build service was unavailable.",
  completed: "Execution stage completed.",
  unknown: "No attributable failure reason was recorded.",
};

/** Defense in depth at capture AND admission. Only diagnostic-shaped lines survive.
 * Commands, arbitrary stdout, environment dumps and credentials are not operator evidence.
 */
export function sanitizeSourceDiagnostic(input: SourceBuildDiagnostic): SourceBuildDiagnostic {
  const checked = SourceBuildDiagnosticSchema.parse(input);
  const lines: string[] = [];
  let privateKey = false;
  let dropped = false;
  let size = 0;
  for (const raw of (checked.excerpt ?? "").split(/\r?\n/u)) {
    if (/-----BEGIN .*PRIVATE KEY-----/u.test(raw)) privateKey = true;
    if (privateKey) {
      dropped = true;
      if (/-----END .*PRIVATE KEY-----/u.test(raw)) privateKey = false;
      continue;
    }
    const line = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u001b]/gu, "").trim();
    if (!line) continue;
    if (/authorization|bearer|\bcommand\b|\bprocess\b.*(?:execute|running)|(?:^|\s)(?:sh|bash|curl|wget|printenv|env)\s|basic\s+[A-Za-z0-9+/]|password|passwd|secret|token|credential|cookie|private.?key|\b(?:ENV|ARG|RUN)\b|(?:^|\s)(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=|https?:\/\/|ssh:\/\/|git@|\/run\/secrets|\/\.?(?:ssh|aws|config)\//iu.test(line) ||
        !/(?:\berror\b|\bfailed\b|\bfatal\b|\btimeout\b|\bcanceled\b|\bcancelled\b|\bnot found\b|\bnot resolve\b|\bdenied\b|\bexit code\b|\bERR_[A-Z_]+\b|\bTS[0-9]{4}\b|npm ERR!)/iu.test(line)) {
      dropped = true;
      continue;
    }
    // Opaque keys, encoded payloads and credential-shaped strings are excluded.
    if (/[A-Za-z0-9_+\/-]{40,}={0,2}/u.test(line) || /gh[pousr]_|github_pat_|AKIA[0-9A-Z]/u.test(line)) {
      dropped = true;
      continue;
    }
    const bounded = line.slice(0, 1_024);
    const bytes = new TextEncoder().encode(bounded + "\n").byteLength;
    if (size + bytes > SOURCE_DIAGNOSTIC_MAX_BYTES) { dropped = true; break; }
    if (bounded !== line) dropped = true;
    lines.push(bounded);
    size += bytes;
  }
  return {
    stage: checked.stage, reason: checked.reason,
    summary: REASON_SUMMARIES[checked.reason],
    ...(lines.length ? { excerpt: lines.join("\n") } : {}),
    truncated: checked.truncated || dropped,
  };
}
