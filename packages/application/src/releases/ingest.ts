import {
  ReleaseCandidateManifestSchema,
  ReleaseCandidateSchema,
  type ReleaseAdmissionRepository,
  type ReleaseCandidate,
  type ReleaseCandidateManifest,
  type ReleaseCandidateVerifier,
  type ReleaseClock,
  type ReleaseIdSource,
} from "./model.js";

export type IngestReleaseResult =
  | { readonly kind: "admitted"; readonly candidate: ReleaseCandidate; readonly duplicate: boolean }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "retry"; readonly reason: string };

export interface IngestReleaseDeps {
  readonly releases: ReleaseAdmissionRepository;
  readonly verifier: ReleaseCandidateVerifier;
  readonly clock: ReleaseClock;
  readonly ids: ReleaseIdSource;
}

function sameManifest(candidate: ReleaseCandidate, manifest: ReleaseCandidateManifest): boolean {
  return (
    candidate.version === manifest.version &&
    candidate.imageRepository === manifest.imageRepository &&
    candidate.imageDigest === manifest.catalog.runtimeBaseDigest &&
    stableJson(candidate.catalog) === stableJson(manifest.catalog) &&
    stableJson(candidate.runtimeMetadata) === stableJson(manifest.runtimeMetadata) &&
    candidate.signatureRef === manifest.signatureRef &&
    candidate.provenanceRef === manifest.provenanceRef
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).sort().join(",")}]`;
  }
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

async function appendAudit(
  deps: IngestReleaseDeps,
  actorId: string,
  requestId: string,
  targetId: string,
  outcome: "accepted" | "denied" | "failed",
  metadata: Readonly<Record<string, string | number | boolean | null>>,
): Promise<void> {
  await deps.releases.appendAudit({
    actorId,
    requestId,
    action: "release.candidate.admit",
    targetId,
    outcome,
    metadata,
    occurredAt: deps.clock.now(),
  });
}

/**
 * Admits an explicit candidate publication. A mutable registry tag is not an
 * input: the runtime-base digest and the producer catalog's exact digests are
 * verified before the candidate enters the scheduled discovery catalog.
 */
export async function ingestReleaseCandidate(
  deps: IngestReleaseDeps,
  input: unknown,
  actorId: string,
  requestId: string,
): Promise<IngestReleaseResult> {
  const parsed = ReleaseCandidateManifestSchema.safeParse(input);
  if (!parsed.success) {
    await appendAudit(deps, actorId, requestId, "unknown", "denied", {
      reason: "invalid release candidate manifest",
    });
    return { kind: "denied", reason: "invalid release candidate manifest" };
  }
  const manifest = parsed.data;
  let verification;
  try {
    verification = await deps.verifier.verify(manifest);
  } catch {
    await appendAudit(deps, actorId, requestId, manifest.catalog.runtimeBaseDigest, "failed", {
      reason: "release evidence provider unavailable",
    });
    return { kind: "retry", reason: "release evidence provider unavailable" };
  }
  if (verification.kind === "retry") {
    await appendAudit(deps, actorId, requestId, manifest.catalog.runtimeBaseDigest, "failed", {
      reason: verification.reason,
    });
    return verification;
  }
  if (verification.kind === "rejected") {
    await appendAudit(deps, actorId, requestId, manifest.catalog.runtimeBaseDigest, "denied", {
      reason: verification.reason,
    });
    return { kind: "denied", reason: verification.reason };
  }

  const imageDigest = manifest.catalog.runtimeBaseDigest;
  const existing = await deps.releases.findByDigest(imageDigest);
  if (existing) {
    if (!sameManifest(existing, manifest)) {
      await appendAudit(deps, actorId, requestId, imageDigest, "denied", {
        reason: "digest already exists with conflicting release metadata",
        releaseId: existing.id,
      });
      return { kind: "denied", reason: "digest already exists with conflicting release metadata" };
    }
    await appendAudit(deps, actorId, requestId, imageDigest, "accepted", {
      releaseId: existing.id,
      duplicate: true,
    });
    return { kind: "admitted", candidate: existing, duplicate: true };
  }

  const now = deps.clock.now();
  const candidate = ReleaseCandidateSchema.parse({
    schemaVersion: 1,
    id: deps.ids.newReleaseId(deps.clock.nowMs()),
    version: manifest.version,
    imageRepository: manifest.imageRepository,
    imageDigest,
    catalog: manifest.catalog,
    runtimeMetadata: manifest.runtimeMetadata,
    signatureRef: manifest.signatureRef,
    provenanceRef: manifest.provenanceRef,
    admission: {
      registryConfirmed: true,
      provenanceVerified: true,
      runtimeMetadataVerified: true,
      evidence: [...verification.evidence],
      verifiedAt: now,
    },
    status: "candidate",
    createdAt: now,
  });

  const created = await deps.releases.createCandidateWithAudit({
    candidate,
    audit: {
      actorId,
      requestId,
      action: "release.candidate.admit",
      targetId: imageDigest,
      outcome: "accepted",
      metadata: { releaseId: candidate.id, duplicate: false },
      occurredAt: now,
    },
  });
  if (created === "duplicate") {
    const winner = await deps.releases.findByDigest(imageDigest);
    if (!winner || !sameManifest(winner, manifest)) {
      await appendAudit(deps, actorId, requestId, imageDigest, "denied", {
        reason: "concurrent candidate admission created conflicting metadata",
      });
      return {
        kind: "denied",
        reason: "concurrent candidate admission created conflicting metadata",
      };
    }
    await appendAudit(deps, actorId, requestId, imageDigest, "accepted", {
      releaseId: winner.id,
      duplicate: true,
    });
    return { kind: "admitted", candidate: winner, duplicate: true };
  }

  return { kind: "admitted", candidate, duplicate: false };
}
