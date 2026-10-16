import { z } from "zod";
import {
  BuildCatalogSchema,
  RuntimeMetadataSchema,
  type BuildCatalog,
  type RuntimeMetadata,
} from "@praetorium/contracts";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const VersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );

/** The immutable producer inputs that define a Runtime Base release. */
export const ReleaseBuildCatalogSchema = BuildCatalogSchema;
export type ReleaseBuildCatalog = BuildCatalog;

/** Untrusted release metadata supplied to the operator admission operation. */
export const ReleaseCandidateManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    version: VersionSchema,
    imageRepository: z.string().min(1).max(255),
    catalog: ReleaseBuildCatalogSchema,
    runtimeMetadata: RuntimeMetadataSchema,
    signatureRef: z.string().min(1).max(2048),
    provenanceRef: z.string().min(1).max(2048),
  })
  .refine(
    (manifest) => manifest.runtimeMetadata.producerRevision === manifest.catalog.producerRevision,
    {
      message: "runtime metadata and build catalog must identify the same producer revision",
      path: ["runtimeMetadata", "producerRevision"],
    },
  );
export type ReleaseCandidateManifest = z.infer<typeof ReleaseCandidateManifestSchema>;

/** A catalog row exists only after immutable image and provenance admission. */
export const ReleaseCandidateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    version: VersionSchema,
    imageRepository: z.string().min(1).max(255),
    imageDigest: DigestSchema,
    catalog: ReleaseBuildCatalogSchema,
    runtimeMetadata: RuntimeMetadataSchema,
    signatureRef: z.string().min(1).max(2048),
    provenanceRef: z.string().min(1).max(2048),
    admission: z.strictObject({
      registryConfirmed: z.literal(true),
      provenanceVerified: z.literal(true),
      runtimeMetadataVerified: z.literal(true),
      evidence: z.array(z.string().min(1).max(512)),
      verifiedAt: z.iso.datetime(),
    }),
    status: z.enum(["candidate", "available"]),
    createdAt: z.iso.datetime(),
  })
  .refine((candidate) => candidate.imageDigest === candidate.catalog.runtimeBaseDigest, {
    message: "release image digest must match the producer catalog runtime base digest",
    path: ["imageDigest"],
  })
  .refine(
    (candidate) =>
      candidate.runtimeMetadata.producerRevision === candidate.catalog.producerRevision,
    {
      message: "runtime metadata and build catalog must identify the same producer revision",
      path: ["runtimeMetadata", "producerRevision"],
    },
  );
export type ReleaseCandidate = z.infer<typeof ReleaseCandidateSchema>;

export const StableReleaseChannelSchema = z.strictObject({
  key: z.literal("stable"),
  currentReleaseId: z.string().min(1).nullable(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
});
export type StableReleaseChannel = z.infer<typeof StableReleaseChannelSchema>;

export type CursorPage<T> = {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
};

export type DiscoveryCheckpoint = {
  readonly cursor: string | null;
  readonly revision: number;
};

export type CandidateWorkflowState =
  | "queued"
  | "canary_building"
  | "canary_starting"
  | "canary_observing"
  | "canary_cleanup"
  | "promoting"
  | "promoted"
  | "rolling_out"
  | "complete"
  | "blocked"
  | "rejected"
  | "superseded";

export const CanaryHealthEvidenceSchema = z.strictObject({
  artifactDigest: DigestSchema,
  runtimeId: z.string().min(1).max(128),
  operationId: z.string().min(1).max(128),
  runtimeEpoch: z.number().int().positive(),
  providerObservationId: z.string().min(1).max(512),
  source: z.literal("runtime-provisioner-observation"),
  imageIdentityVerified: z.literal(true),
  observedAt: z.number().int().nonnegative(),
  checks: z.strictObject({
    startup: z.literal(true),
    auth: z.literal(true),
    uiApiMcp: z.literal(true),
    persistence: z.literal(true),
  }),
  checkEvidence: z.strictObject({
    startup: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
    uiApiMcp: z.string().min(1).max(512),
    persistence: z.string().min(1).max(512),
  }),
});
export type CanaryHealthEvidence = z.infer<typeof CanaryHealthEvidenceSchema>;

/** Stop completion must be backed by a current provider census, not desired state. */
export const CanaryCleanupEvidenceSchema = z.strictObject({
  operationId: z.string().min(1).max(128),
  startedOperationId: z.string().min(1).max(128),
  observedAt: z.number().int().nonnegative(),
  writerAbsence: z.strictObject({
    instanceId: z.string().min(1).max(128),
    repositoryId: z.number().int().positive(),
    retiredEpoch: z.number().int().nonnegative().nullable(),
    providerObservationId: z.string().min(1).max(512),
    censusObservedAt: z.number().int().nonnegative(),
    remainingWriters: z.literal(0),
    evidenceIdentities: z.array(z.string().min(1).max(512)).max(128),
    source: z.literal("runtime-provider-census"),
  }),
});
export type CanaryCleanupEvidence = z.infer<typeof CanaryCleanupEvidenceSchema>;

export type CandidateWorkflow = {
  readonly releaseId: string;
  readonly state: CandidateWorkflowState;
  readonly revision: number;
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  readonly leaseOwner: string | null;
  readonly leaseEpoch: number;
  readonly leaseExpiresAt: number | null;
  readonly canaryArtifactDigest: string | null;
  readonly canaryBuildKey: string | null;
  readonly canaryRuntimeId: string | null;
  readonly canaryOperationId: string | null;
  readonly healthySince: number | null;
  readonly lastHealthyAt: number | null;
  readonly lastHealthEvidence: CanaryHealthEvidence | null;
  readonly cleanupEvidence: CanaryCleanupEvidence | null;
  readonly followerCursor: string | null;
  readonly followerPlanningComplete: boolean;
  readonly canaryCleanupComplete: boolean;
  readonly cleanupDisposition: "promote" | "reject" | null;
  readonly failureCode: string | null;
  readonly updatedAt: string;
};

export type CandidateWorkLease = {
  readonly candidate: ReleaseCandidate;
  readonly workflow: CandidateWorkflow;
  readonly owner: string;
  readonly epoch: number;
};

export type ReleaseAdmissionResult =
  | { readonly kind: "verified"; readonly evidence: readonly string[] }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "retry"; readonly reason: string };

export interface ReleaseAdmissionProvider {
  /** Re-checks current immutable registry bytes and the configured signer policy. */
  verify(candidate: ReleaseCandidate): Promise<ReleaseAdmissionResult>;
}

export interface ReleaseCatalogRepository {
  findById(id: string): Promise<ReleaseCandidate | null>;
  findByDigest(imageDigest: string): Promise<ReleaseCandidate | null>;
  listCandidates(cursor: string | null, limit: number): Promise<CursorPage<ReleaseCandidate>>;
  createCandidate(candidate: ReleaseCandidate): Promise<"created" | "duplicate">;
}

export interface ReleasePromotionRepository extends ReleaseCatalogRepository {
  getStableChannel(): Promise<StableReleaseChannel>;
  /** Atomically updates the stable channel and makes the candidate available. */
  promoteStable(input: {
    readonly releaseId: string;
    readonly expectedRevision: number;
    readonly promotedAt: string;
  }): Promise<"promoted" | "conflict" | "ineligible">;

  getDiscoveryCheckpoint(): Promise<DiscoveryCheckpoint>;
  /** Inserts work by release ID and advances the cursor with revision CAS. */
  commitDiscoveryPage(input: {
    readonly expectedRevision: number;
    readonly expectedCursor: string | null;
    readonly page: CursorPage<ReleaseCandidate>;
    readonly at: string;
  }): Promise<"advanced" | "conflict">;

  claimCandidateWork(input: {
    readonly owner: string;
    readonly now: number;
    readonly leaseMs: number;
    readonly limit: number;
  }): Promise<readonly CandidateWorkLease[]>;
  saveCandidateWorkflow(input: {
    readonly lease: CandidateWorkLease;
    readonly next: Omit<
      CandidateWorkflow,
      "revision" | "leaseOwner" | "leaseEpoch" | "leaseExpiresAt"
    >;
    readonly releaseLease: boolean;
  }): Promise<"saved" | "stale">;
  hasUnsettledRollouts(releaseId: string): Promise<boolean>;
}

export interface ReleaseAdmissionRepository extends ReleaseCatalogRepository {
  /** Candidate insertion and its accepted audit event commit atomically. */
  createCandidateWithAudit(input: {
    readonly candidate: ReleaseCandidate;
    readonly audit: {
      readonly actorId: string;
      readonly requestId: string;
      readonly action: "release.candidate.admit";
      readonly targetId: string;
      readonly outcome: "accepted";
      readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
      readonly occurredAt: string;
    };
  }): Promise<"created" | "duplicate">;
  appendAudit(input: {
    readonly actorId: string;
    readonly requestId: string;
    readonly action: "release.candidate.admit";
    readonly targetId: string;
    readonly outcome: "accepted" | "denied" | "failed";
    readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
    readonly occurredAt: string;
  }): Promise<void>;
}

export interface ReleaseCandidateVerifier {
  verify(input: ReleaseCandidateManifest): Promise<ReleaseAdmissionResult>;
}

/** Verifies the complete producer contract against immutable producer/image evidence. */
export interface ReleaseProducerMetadataVerifier {
  verify(input: {
    readonly imageRepository: string;
    readonly imageDigest: string;
    readonly producerRevision: string;
    readonly catalog: BuildCatalog;
    readonly runtimeMetadata: RuntimeMetadata;
  }): Promise<ReleaseAdmissionResult>;
}

export interface ReleaseClock {
  nowMs(): number;
  now(): string;
}

export interface ReleaseIdSource {
  newReleaseId(nowMs: number): string;
}
