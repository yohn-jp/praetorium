import type { BuildProgressSchema } from "@praetorium/contracts";
import type { z } from "zod";
type BuildProgress = z.infer<typeof BuildProgressSchema>;
import type {
  CandidateWorkflow,
  DisposableCanaryBinding,
  ReleaseCandidate,
} from "@praetorium/application/releases";

/** Bounded operator metadata; never exposes leases or source/credential payloads. */
export interface ReleaseRetryStatus {
  readonly release: Pick<ReleaseCandidate, "id" | "version" | "imageDigest" | "status">;
  readonly workflow: Pick<CandidateWorkflow,
    "state" | "revision" | "failureCode" | "attempts" | "nextAttemptAt" |
    "canaryBuildKey" | "canaryOperationId">;
  readonly build: {
    readonly id: string;
    readonly status: string;
    readonly attemptCount: number;
    readonly progress: BuildProgress | null;
    readonly failure: { readonly code: string; readonly retryable: boolean } | null;
  } | null;
}

export interface ReleaseRetryCommand {
  readonly releaseId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly now: number;
  readonly canary: DisposableCanaryBinding;
}

export type ReleaseRetryResult =
  | { readonly kind: "accepted"; readonly duplicate: boolean; readonly status: ReleaseRetryStatus }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict"; readonly reason: string };
