import { z } from "zod";
import { SigstoreProvenanceVerifier } from "@praetorium/ghcr/provenance";
import { createT11RolloutComposition } from "./rollout-composition.js";
import { verifyReleaseProducerMetadata } from "./release-producer-metadata.js";
import { createReleaseCanaryObservationReader } from "./release-canary-observations.js";
import { SourceProducerProofVerifier } from "./source-producer-verifier.js";
import { createRegistryBackedReleaseVerifier, ingestReleaseCandidate, ReleaseCandidateManifestSchema, type ReleaseCandidateManifest } from "@praetorium/application/releases";
import { repositoryPathForHost, type SourceProducerResult } from "@praetorium/contracts";
import { runStableReleaseWork } from "./scheduled.js";
import { equalSecret } from "./app.js";
import type { composeBuildServices } from "./build-composition.js";
import type { D1Database } from "@praetorium/persistence/d1";
import type { InstanceService } from "@praetorium/application/instances";
import type { OperationService } from "@praetorium/application/operations";
import type { WorkNotificationDispatcher } from "./work-notification-scheduler.js";

const Policy = z.strictObject({
  workerId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/u),
  clusterId: z.string().min(1).max(128),
  operatorActorId: z.string().min(1).max(128),
  canaryProbeActorId: z.number().int().positive().safe(),
  signerIdentityAllowlist: z
    .array(
      z.strictObject({
        subjectAlternativeName: z.string().min(1).max(1024),
        issuer: z.string().min(1).max(1024).optional(),
      }),
    )
    .min(1)
    .max(32),
  canary: z.strictObject({
    owner: z.string().min(1).max(128),
    disposable: z.literal(true),
    production: z.literal(false),
    repositoryId: z.number().int().positive().safe(),
    instanceId: z.string().regex(/^ins_[0-9A-HJKMNP-TV-Z]{26}$/u),
    bindingEpoch: z.number().int().nonnegative().safe(),
    authorizationRevision: z.number().int().nonnegative().safe(),
    requestedModules: z.array(z.string().min(1).max(128)).max(128),
    resourceProfileId: z.string().min(1).max(128),
  }),
});

/** Two already-authorized entry points for one operator authority.
 * Public bearer tokens are not accepted from browsers as operator grants.
 * The delegated path requires the existing private Gateway service secret AND
 * exactly the configured operator's GitHub user ID.
 */
export async function authorizeConfiguredReleaseOperator(
  headers: Headers,
  input: { operatorToken: string; gatewayServiceSecret: string | undefined; adminServiceSecret?: string; operatorActorId: string },
): Promise<{ actorId: string } | null> {
  if (await equalSecret(
    headers.get("Authorization")?.replace(/^Bearer /u, "") ?? "", input.operatorToken,
  )) return { actorId: input.operatorActorId };
  if (
    input.gatewayServiceSecret &&
    headers.get("X-Praetorium-Admin-Actor") === input.operatorActorId &&
    await equalSecret(headers.get("X-Control-Plane-Gateway-Auth") ?? "", input.gatewayServiceSecret)
  ) return { actorId: input.operatorActorId };
  if (
    input.adminServiceSecret &&
    headers.get("X-Praetorium-Admin-Actor") === input.operatorActorId &&
    await equalSecret(headers.get("X-Control-Plane-Admin-Auth") ?? "", input.adminServiceSecret)
  ) return { actorId: input.operatorActorId };
  return null;
}

/** Operator-selected owned canary, never a repository user's configuration input. */
export function composeReleaseServices(input: {
  db: D1Database;
  builds: ReturnType<typeof composeBuildServices>;
  instances: InstanceService;
  operations: OperationService;
  policyJson: string;
  operatorToken: string;
  /** Existing authenticated Gateway service binding, never exposed to browsers. */
  gatewayServiceSecret?: string;
  adminServiceSecret?: string;
  notifyWorkAvailable?: WorkNotificationDispatcher;
}) {
  const policy = Policy.parse(JSON.parse(input.policyJson));
  if (!/^[\x21-\x7e]{32,4096}$/u.test(input.operatorToken))
    throw new TypeError("Separate release operator credential required");
  const sourceProofVerifier = new SourceProducerProofVerifier(
    input.db, input.builds.sourceRegistry, input.builds.sourceBuilderKeys,
    input.builds.sourceProducerRepository,
  );
  const signatureVerifier = new SigstoreProvenanceVerifier({
    signerIdentityAllowlist: policy.signerIdentityAllowlist.map(
      ({ subjectAlternativeName, issuer }) => ({
        subjectAlternativeName,
        ...(issuer === undefined ? {} : { issuer }),
      }),
    ),
  });
  const provenance = {
    verify: (proof: { readonly imageDigest: string; readonly signatureRef: string; readonly provenanceRef: string }) =>
      proof.signatureRef.startsWith("https://control.praetorium.yohn.jp/internal/source-proofs/")
        ? sourceProofVerifier.provenance(proof)
        : signatureVerifier.verify(proof),
  };
  const producerMetadata = { verify: verifyReleaseProducerMetadata };
  const services = createT11RolloutComposition({
    db: input.db,
    configurations: input.builds.configurations,
    canaryConfigurations: input.builds.canaryConfigurations,
    instances: input.instances,
    operations: input.operations,
    canaryBinding: policy.canary,
    canaryObservations: createReleaseCanaryObservationReader(input.operations, input.db),
    defaultClusterId: policy.clusterId,
    clock: { nowMs: Date.now, now: () => new Date().toISOString() },
    ids: { newReleaseId: () => `rel_${crypto.randomUUID()}` },
    workerId: policy.workerId,
    ...(input.notifyWorkAvailable
      ? { notifyWorkAvailable: input.notifyWorkAvailable }
      : {}),
    authorizeOperator: (headers) => authorizeConfiguredReleaseOperator(headers, {
      operatorToken: input.operatorToken,
      gatewayServiceSecret: input.gatewayServiceSecret,
      ...(input.adminServiceSecret ? {adminServiceSecret: input.adminServiceSecret} : {}),
      operatorActorId: policy.operatorActorId,
    }),
    registry: input.builds.registry,
    provenance,
    producerMetadata,
  });
  const sourceAdmissionVerifier = createRegistryBackedReleaseVerifier({
    registry: input.builds.registry, provenance, producerMetadata,
  });
  const sourceClock = { nowMs: Date.now, now: () => new Date().toISOString() };
  return {
    ...services,
    sourceProofVerifier,
    /** Reuse the same immutable catalog and Canary release authority. */
    admitSourceRelease: async (job: {
      readonly job_id: string; readonly actor_id: string; readonly release_version: string;
    }, result: SourceProducerResult) => {
      const url = `https://control.praetorium.yohn.jp/internal/source-proofs/${job.job_id}`;
      const manifest: ReleaseCandidateManifest = ReleaseCandidateManifestSchema.parse({
        schemaVersion: 1, version: job.release_version,
        imageRepository: repositoryPathForHost(
          result.statement.imageRepository, input.builds.sourceRegistry.registryHost,
        ),
        catalog: result.catalog, runtimeMetadata: result.runtimeMetadata,
        signatureRef: url, provenanceRef: url,
      });
      return ingestReleaseCandidate({
        releases: services.releases, verifier: sourceAdmissionVerifier,
        clock: sourceClock, ids: { newReleaseId: () => `rel_${crypto.randomUUID()}` },
      }, manifest, job.actor_id, job.job_id);
    },
    progressAdmittedSourceRelease: async () => runStableReleaseWork(services.scheduled, {promotionPasses:2}),
    canaryProbeActor: {
      repositoryId: policy.canary.repositoryId,
      actorId: String(policy.canaryProbeActorId),
    },
  };
}
