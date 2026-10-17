import { z } from "zod";
import { SigstoreProvenanceVerifier } from "@praetorium/ghcr/provenance";
import { createT11RolloutComposition } from "./rollout-composition.js";
import { verifyReleaseProducerMetadata } from "./release-producer-metadata.js";
import { createReleaseCanaryObservationReader } from "./release-canary-observations.js";
import { equalSecret } from "./app.js";
import type { composeBuildServices } from "./build-composition.js";
import type { D1Database } from "@praetorium/persistence/d1";
import type { InstanceService } from "@praetorium/application/instances";
import type { OperationService } from "@praetorium/application/operations";

const Policy = z.strictObject({
  workerId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/u),
  clusterId: z.string().min(1).max(128),
  operatorActorId: z.string().min(1).max(128),
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

/** Operator-selected owned canary, never a repository user's configuration input. */
export function composeReleaseServices(input: {
  db: D1Database;
  builds: ReturnType<typeof composeBuildServices>;
  instances: InstanceService;
  operations: OperationService;
  policyJson: string;
  operatorToken: string;
}) {
  const policy = Policy.parse(JSON.parse(input.policyJson));
  if (!/^[\x21-\x7e]{32,4096}$/u.test(input.operatorToken))
    throw new TypeError("Separate release operator credential required");
  return createT11RolloutComposition({
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
    authorizeOperator: async (headers) =>
      (await equalSecret(
        headers.get("Authorization")?.replace(/^Bearer /u, "") ?? "",
        input.operatorToken,
      ))
        ? { actorId: policy.operatorActorId }
        : null,
    registry: input.builds.registry,
    provenance: new SigstoreProvenanceVerifier({
      signerIdentityAllowlist: policy.signerIdentityAllowlist.map(
        ({ subjectAlternativeName, issuer }) => ({
          subjectAlternativeName,
          ...(issuer === undefined ? {} : { issuer }),
        }),
      ),
    }),
    producerMetadata: { verify: verifyReleaseProducerMetadata },
  });
}
