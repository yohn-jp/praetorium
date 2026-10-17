import { z } from "zod";
import { planCacheMaintenance } from "./cache-maintenance.js";
import { ResourceRequirementsSchema, buildKey } from "@praetorium/contracts";
import { BuildQueueService } from "@praetorium/application/builds";
import { BuildArtifactCache } from "@praetorium/application/build-cache";
import { ArtifactAdmissionService } from "@praetorium/application/artifacts";
import { ConfigurationService } from "@praetorium/application/configurations";
import { ReleaseCandidateSchema } from "@praetorium/application/releases";
import {
  D1ArtifactCacheStore,
  D1BuildStore,
  D1ConfigurationStore,
  type D1Database,
} from "@praetorium/persistence/d1";
import { GhcrRegistryClient } from "@praetorium/ghcr/registry";
import { OperatorBuilderSignatureVerifier } from "@praetorium/ghcr/builder-signature";
import { normalizeComposition, type ProducerCatalogResolver } from "@praetorium/scriptorium";

const Policy = z.strictObject({
  registryUrl: z.url().startsWith("https://"),
  allowedRepositories: z.array(z.string().min(1)).min(1).max(64),
  outputRepository: z.string().min(1),
  maxImageLayerBytes: z.number().int().positive().safe(),
  maxImageVerificationMs: z.number().int().positive().max(120000),
  maxRegistryRequestMs: z.number().int().positive().max(60000),
  runtimeResourceLimits: ResourceRequirementsSchema,
  cacheRetention: z.strictObject({
    maxBytes: z.number().int().nonnegative().safe(),
    maxEntries: z.number().int().positive().safe(),
    minAgeMs: z.number().int().nonnegative().safe(),
    maxEvictions: z.number().int().min(1).max(32),
  }),
  targetPlatform: z.enum(["linux/amd64", "linux/arm64"]),
  builderKeys: z
    .array(
      z.strictObject({
        keyId: z.string().min(1),
        publicKeyBase64: z.string().min(1),
        revoked: z.boolean().optional(),
        validFrom: z.iso.datetime().optional(),
        validUntil: z.iso.datetime().optional(),
      }),
    )
    .min(1)
    .max(32),
});
const PullCredential = z.strictObject({ username: z.string().min(1), password: z.string().min(1) });
export class ProducerContractUnavailable extends Error {
  readonly code = "PRODUCER_CONTRACT_UNAVAILABLE";
}
/** Registry credentials and trusted policy are operator bindings, never request fields. */
export function composeBuildServices(
  db: D1Database,
  policyJson: string,
  pullCredentialJson?: string,
  producerResolver?: ProducerCatalogResolver,
) {
  const policy = Policy.parse(JSON.parse(policyJson));
  if (!policy.allowedRepositories.includes(policy.outputRepository))
    throw new TypeError("Output repository must be explicitly approved");
  const registry = new GhcrRegistryClient({
    registryUrl: policy.registryUrl,
    allowedRepositories: policy.allowedRepositories,
    maxImageLayerBytes: policy.maxImageLayerBytes,
    maxImageVerificationMs: policy.maxImageVerificationMs,
    maxRegistryRequestMs: policy.maxRegistryRequestMs,
    ...(pullCredentialJson
      ? { pullCredential: PullCredential.parse(JSON.parse(pullCredentialJson)) }
      : {}),
  });
  const signer = new OperatorBuilderSignatureVerifier(
    policy.builderKeys.map((key) => ({
      keyId: key.keyId,
      publicKeyBase64: key.publicKeyBase64,
      ...(key.revoked === undefined ? {} : { revoked: key.revoked }),
      ...(key.validFrom === undefined ? {} : { validFrom: key.validFrom }),
      ...(key.validUntil === undefined ? {} : { validUntil: key.validUntil }),
    })),
  );
  const admission = new ArtifactAdmissionService(registry, signer);
  const cacheStore = new D1ArtifactCacheStore(db);
  const cache = new BuildArtifactCache(admission, cacheStore);
  const builds = new BuildQueueService(new D1BuildStore(db), admission, {
    approvedArtifact: { registryHost: registry.registryHost, repository: policy.outputRepository },
  });
  const createConfigurations = (allowCandidate: boolean) =>
    new ConfigurationService(new D1ConfigurationStore(db), {
      async plan(selection) {
        const row = await db
          .prepare(
            `SELECT candidate_json FROM release_candidates WHERE release_id=? AND status ${allowCandidate ? "IN ('available', 'candidate')" : "= 'available'"}`,
          )
          .bind(selection.releaseId)
          .first<{ candidate_json: string }>();
        if (!row) throw new TypeError("Approved release unavailable");
        const release = ReleaseCandidateSchema.parse(JSON.parse(row.candidate_json));
        if (!producerResolver)
          throw new ProducerContractUnavailable(
            "S01 versioned producer catalog resolver is not configured",
          );
        const composition = normalizeComposition(
          release.catalog,
          {
            requestedModules: selection.requestedModules,
            targetPlatform: policy.targetPlatform,
            resourceProfileId: selection.resourceProfileId,
          },
          producerResolver,
        );
        const requested = composition.selectedResourceProfile;
        const caps = policy.runtimeResourceLimits;
        if (
          requested.cpuMilli > caps.cpuMilli ||
          requested.memoryMiB > caps.memoryMiB ||
          requested.ephemeralStorageMiB > caps.ephemeralStorageMiB
        )
          throw new TypeError("Resource profile exceeds operator limits");
        const cached = await cache.lookup(await buildKey(composition.buildInput));
        if (!cached.hit && cached.reason !== "not_found") {
          throw Object.assign(
            new Error("Shared artifact cache cannot be reused under current policy"),
            {
              code:
                cached.reason === "conflicted" ? "BUILD_CACHE_CONFLICT" : "BUILD_CACHE_UNAVAILABLE",
            },
          );
        }
        return {
          buildInput: composition.buildInput,
          resources: {
            cpuMilli: composition.selectedResourceProfile.cpuMilli,
            memoryMiB: composition.selectedResourceProfile.memoryMiB,
            ephemeralStorageMiB: composition.selectedResourceProfile.ephemeralStorageMiB,
          },
          runtimeMetadata: release.runtimeMetadata,
        };
      },
    });
  return {
    builds,
    configurations: createConfigurations(false),
    canaryConfigurations: createConfigurations(true),
    registry,
    admission,
    resourceLimits: policy.runtimeResourceLimits,
    cache,
    cacheStore,
    planCacheMaintenance: (now: Date) =>
      planCacheMaintenance({ db, cacheStore, policy: policy.cacheRetention, now }),
  };
}
