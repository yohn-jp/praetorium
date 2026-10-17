import { Hono } from "hono";
import { z } from "zod";
import { DigestSchema, PersistenceObservationSchema } from "@praetorium/contracts";
import type { D1Database } from "@praetorium/persistence/d1";
import { boundedJson } from "./app.js";

const Id = z.string().min(1).max(512);
export const RuntimeHealthEvidenceSchema = z.strictObject({
  assignment: z.object({
    instanceId: Id,
    repositoryId: z.number().int().positive().safe(),
    runtimeEpoch: z.number().int().positive().safe(),
    generation: z.number().int().nonnegative().safe(),
    clusterId: Id,
    deployment: z.object({
      revisionId: Id,
      imageDigest: DigestSchema,
      platformManifestDigest: DigestSchema,
      compositionManifestDigest: DigestSchema,
    }),
  }),
  providerObservationId: Id,
  actualImageDigest: DigestSchema,
  producerObservedAt: z.iso.datetime(),
  compositionManifestDigest: DigestSchema,
  enabledModuleIds: z.array(z.string().min(1).max(64)).max(256),
  applicationProbeId: Id,
  validGrantProbeId: Id,
  wrongRepositoryProbeId: Id,
  wrongEpochProbeId: Id,
  invalidServiceCredentialProbeId: Id,
  uiApiMcpProbeId: Id,
  persistenceProbeId: Id,
  persistence: PersistenceObservationSchema,
  verifiedAt: z.iso.datetime(),
});
const Input = z.strictObject({
  workerId: Id,
  clusterId: Id,
  operationId: Id,
  readinessEvidence: RuntimeHealthEvidenceSchema,
});

/** Mounted behind Provisioner service authentication. Every sample is fenced to
 * the current ready writer; a completed operation lease is never fabricated. */
export function createRuntimeHealthRoutes(deps: {
  db: D1Database;
  workerId: string;
  clusterId: string;
  now?: () => number;
}) {
  const app = new Hono();
  app.post("/internal/provisioner/runtime-health", async (c) => {
    const input = Input.parse(await boundedJson(c.req.raw));
    const e = input.readinessEvidence,
      a = e.assignment,
      d = a.deployment;
    const now = (deps.now ?? Date.now)(),
      observedAt = Date.parse(e.verifiedAt),
      producerAt = Date.parse(e.producerObservedAt);
    if (
      input.workerId !== deps.workerId ||
      input.clusterId !== deps.clusterId ||
      a.clusterId !== deps.clusterId ||
      observedAt > now ||
      now - observedAt > 30_000 ||
      producerAt > observedAt ||
      observedAt - producerAt > 30_000 ||
      e.actualImageDigest !== d.platformManifestDigest ||
      e.compositionManifestDigest !== d.compositionManifestDigest ||
      e.persistence.state !== "verified" ||
      e.persistence.observedRemoteCommit === null
    ) {
      return c.json({ error: { code: "RUNTIME_HEALTH_FENCED" } }, 409);
    }
    // INSERT...SELECT keeps the runtime fence and latest-sample CAS atomic.
    const result = await deps.db
      .prepare(
        `
      INSERT INTO runtime_health_observations
        (instance_id,repository_id,runtime_epoch,generation,cluster_id,operation_id,provider_observation_id,observed_at,evidence_json)
      SELECT i.instance_id,i.repository_id,i.observed_runtime_epoch,i.generation,r.cluster_id,o.operation_id,?,?,?
      FROM logical_instances i
      JOIN repository_bindings b ON b.instance_id=i.instance_id AND b.repository_id=i.repository_id
      JOIN runtime_reservations r ON r.instance_id=i.instance_id AND r.runtime_epoch=i.observed_runtime_epoch
      JOIN deployment_revisions dr ON dr.revision_id=i.observed_revision_id AND dr.instance_id=i.instance_id
      JOIN artifacts art ON art.artifact_digest=dr.artifact_digest AND art.status='admitted'
      JOIN operations o ON o.instance_id=i.instance_id AND o.repository_id=i.repository_id
      WHERE i.instance_id=? AND i.repository_id=? AND i.generation=? AND i.observed_generation=i.generation
        AND i.runtime_epoch=? AND i.observed_runtime_epoch=i.runtime_epoch AND i.observed_state='ready'
        AND i.current_artifact_digest=? AND b.suspended=0 AND r.cluster_id=? AND r.status IN ('reserved','allocated')
        AND dr.revision_id=? AND dr.status='admitted' AND art.platform_manifest_digest=? AND art.composition_manifest_digest=?
        AND o.operation_id=? AND o.status='succeeded' AND o.kind IN ('start','update','redeploy')
        AND o.runtime_epoch=i.observed_runtime_epoch AND o.deployment_revision_id=i.observed_revision_id
        AND NOT EXISTS (SELECT 1 FROM operations active WHERE active.instance_id=i.instance_id AND active.status IN ('pending','claimed','running'))
      ON CONFLICT(instance_id) DO UPDATE SET
        repository_id=excluded.repository_id,runtime_epoch=excluded.runtime_epoch,generation=excluded.generation,
        cluster_id=excluded.cluster_id,operation_id=excluded.operation_id,provider_observation_id=excluded.provider_observation_id,
        observed_at=excluded.observed_at,evidence_json=excluded.evidence_json
      WHERE excluded.observed_at>runtime_health_observations.observed_at
        AND excluded.provider_observation_id<>runtime_health_observations.provider_observation_id
    `,
      )
      .bind(
        e.providerObservationId,
        observedAt,
        JSON.stringify(e),
        a.instanceId,
        a.repositoryId,
        a.generation,
        a.runtimeEpoch,
        d.imageDigest,
        deps.clusterId,
        d.revisionId,
        d.platformManifestDigest,
        d.compositionManifestDigest,
        input.operationId,
      )
      .run();
    return result.meta?.changes === 1
      ? c.json({ recorded: true })
      : c.json({ error: { code: "RUNTIME_HEALTH_FENCED" } }, 409);
  });
  return app;
}
