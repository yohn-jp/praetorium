import {
  BuildClaimRequestSchema,
  BuildHeartbeatRequestSchema,
  BuildReportRequestSchema,
  assertBuildReportBindings,
  canonicalBuildInput,
  type BuildHeartbeatRequest,
  type BuildReportRequest,
} from "@praetorium/contracts";
import { ArtifactAdmissionError } from "../artifacts/admission.js";
import type { VerifiedArtifact } from "../artifacts/types.js";
import type {
  BuildAdmissionFailure,
  BuildArtifactAdmission,
  BuildClaim,
  BuildQueueHeartbeatInput,
  BuildQueueHeartbeatResult,
  BuildQueuePort,
  BuildQueueReportInput,
  BuildQueueReportResult,
  BuildQueueStore,
} from "./queue-types.js";

export type BuildQueueServiceOptions = {
  /** Fixed operator-approved destination. Values never come from worker reports. */
  readonly approvedArtifact: { readonly registryHost: string; readonly repository: string };
  readonly now?: () => number;
  readonly newAttemptId?: () => string;
  readonly newLeaseToken?: () => string;
};

/** Control Plane build queue. It owns server time and verifies signed OCI output before admission. */
export class BuildQueueService implements BuildQueuePort {
  private readonly now: () => number;
  private readonly newAttemptId: () => string;
  private readonly newLeaseToken: () => string;

  constructor(
    private readonly store: BuildQueueStore,
    private readonly admission: BuildArtifactAdmission,
    private readonly options: BuildQueueServiceOptions,
  ) {
    if (!options.approvedArtifact.registryHost || !options.approvedArtifact.repository) {
      throw new TypeError("approved artifact registry and repository are required");
    }
    if (
      !/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::[0-9]{1,5})?$/u.test(options.approvedArtifact.registryHost) ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(options.approvedArtifact.repository)
    ) {
      throw new TypeError("approved artifact destination is invalid");
    }
    this.now = options.now ?? Date.now;
    this.newAttemptId = options.newAttemptId ?? (() => `attempt_${crypto.randomUUID()}`);
    this.newLeaseToken = options.newLeaseToken ?? (() => crypto.randomUUID().replaceAll("-", ""));
  }

  claimNext(input: { readonly workerId: string; readonly now: number; readonly leaseSeconds: number }): Promise<BuildClaim | null> {
    const wireInput = withoutWorkerNow(input);
    const request = BuildClaimRequestSchema.parse(wireInput);
    return this.store.claimNext({
      ...request,
      attemptId: this.newAttemptId(),
      leaseToken: this.newLeaseToken(),
      now: this.serverNow(),
    });
  }

  heartbeat(input: BuildQueueHeartbeatInput): Promise<BuildQueueHeartbeatResult> {
    const wireInput = withoutWorkerNow(input);
    const request: BuildHeartbeatRequest = BuildHeartbeatRequestSchema.parse(wireInput);
    const serverNow = this.serverNow();
    return this.store.heartbeat({ ...request, now: serverNow, serverNow });
  }

  async report(input: BuildQueueReportInput): Promise<BuildQueueReportResult> {
    const wireInput = withoutWorkerNow(input);
    const request: BuildReportRequest = BuildReportRequestSchema.parse(wireInput);
    const serverNow = this.serverNow();
    const reportDigest = await digestJson(request);
    const context = await this.store.getReportContext(request);
    if (!context) return { accepted: false, duplicate: false };

    if (request.sequence === context.reportSequence) {
      return {
        accepted: context.lastReportDigest === reportDigest,
        duplicate: context.lastReportDigest === reportDigest,
      };
    }
    if (request.sequence !== context.reportSequence + 1 || context.leaseExpiresAt <= serverNow) {
      return { accepted: false, duplicate: false };
    }

    let artifact: VerifiedArtifact | null = null;
    let admissionFailure: BuildAdmissionFailure | undefined;
    if (request.result.kind === "succeeded") {
      try {
        try {
          await assertBuildReportBindings(context.input, request, this.options.approvedArtifact);
        } catch {
          throw new ArtifactAdmissionError("build_input_mismatch", "build report does not match the approved persisted input");
        }
        artifact = await this.admission.verifyCandidate(
          { statement: request.result.statement, signature: request.result.signature },
          context.input,
        );
        if (
          artifact.buildKey !== context.buildKey ||
          canonicalBuildInput(artifact.buildInput) !== canonicalBuildInput(context.input) ||
          artifact.image.digest !== request.result.manifestDigest ||
          artifact.compositionManifest.digest !== request.result.compositionManifest.digest
        ) {
          throw Object.assign(new Error("verified output no longer matches the persisted build input"), {
            code: "build_input_mismatch",
          });
        }
      } catch (error) {
        admissionFailure = admissionFailureFor(error);
      }
    }

    return this.store.recordReport({
      request,
      serverNow,
      reportDigest,
      artifact,
      ...(admissionFailure === undefined ? {} : { admissionFailure }),
    });
  }

  private serverNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Control Plane clock returned an invalid timestamp");
    return now;
  }
}

function withoutWorkerNow<T extends { readonly now: number }>(input: T): Record<string, unknown> {
  const wire: Record<string, unknown> = { ...input };
  delete wire.now;
  return wire;
}

function admissionFailureFor(error: unknown): BuildAdmissionFailure {
  const reportedCode =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code.slice(0, 96)
      : "verification_unavailable";
  const code = reportedCode === "registry_unavailable" || reportedCode === "registry_mismatch" ||
    reportedCode === "composition_content_mismatch" || reportedCode === "composition_invalid" ||
    reportedCode === "build_input_mismatch" || reportedCode === "invalid_candidate" ||
    reportedCode === "untrusted_signer"
    ? reportedCode
    : "verification_unavailable";
  return { code, retryable: code === "registry_unavailable" || code === "verification_unavailable" };
}

async function digestJson(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export type {
  BuildClaim,
  BuildQueuePort,
  BuildQueueHeartbeatInput,
  BuildQueueHeartbeatResult,
  BuildQueueReportInput,
  BuildQueueReportResult,
} from "./queue-types.js";
