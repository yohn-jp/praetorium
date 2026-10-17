import {
  BuilderArtifactStatementSchema,
  CompositionManifestSchema,
  RuntimeAssignmentSchema,
  RuntimeMetadataSchema,
  instanceHostname,
  validateCompositionBindings,
  type PersistenceCompatibility,
} from "@praetorium/contracts";
import type { ArtifactRegistryProvider } from "@praetorium/application/artifacts";
import type {
  ClaimedOperation,
  DeploymentRevisionSummary,
} from "@praetorium/application/operations";
export interface RuntimeContextPolicy {
  gatewayOrigin: string;
  controlPlaneOrigin: string;
  instanceHostSuffix: string;
  registryHost: string;
  credentialBrokerLocator: string;
  defaultBranchPolicy: string;
}
function origin(value: string): string {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error("Invalid runtime issuer policy");
  return u.origin;
}
export function resolveAdmittedRuntime(
  snapshot: ClaimedOperation["snapshot"],
  revision: DeploymentRevisionSummary | null,
  runtimeEpoch: number | null,
  policy: RuntimeContextPolicy,
  persistence?: PersistenceCompatibility,
) {
  const gateway = origin(policy.gatewayOrigin),
    control = origin(policy.controlPlaneOrigin);
  const { binding, instance } = snapshot;
  if (
    binding.suspended ||
    binding.instanceId !== instance.instanceId ||
    binding.repositoryId !== instance.repositoryId
  )
    throw new Error("Repository binding is not active");
  const hostname = instanceHostname(instance.instanceId, policy.instanceHostSuffix),
    audience = `https://${hostname}`;
  const resolve = (revision: DeploymentRevisionSummary | null, runtimeEpoch: number | null) => {
    if (revision === null) return null;
    if (
      runtimeEpoch === null ||
      runtimeEpoch < 1 ||
      revision.status !== "admitted" ||
      !revision.artifact ||
      revision.instanceId !== instance.instanceId ||
      revision.repositoryId !== binding.repositoryId
    )
      throw new Error("Deployment revision is not admitted for this runtime");
    const artifact = revision.artifact,
      statement = BuilderArtifactStatementSchema.parse(artifact.statement),
      metadata = RuntimeMetadataSchema.parse(revision.runtimeMetadata);
    if (
      statement.buildKey !== revision.buildKey ||
      statement.artifact.digest !== revision.artifactDigest ||
      statement.artifact.digest !== artifact.manifestDigest ||
      statement.artifact.platformManifestDigest !== artifact.platformManifestDigest ||
      statement.compositionManifest.digest !== artifact.compositionManifestDigest ||
      statement.producerRevision !== metadata.producerRevision
    )
      throw new Error("Admitted runtime artifact identity mismatch");
    const resourceProfileId = revision.selection.resourceProfileId;
    if (typeof resourceProfileId !== "string" || !resourceProfileId)
      throw new Error("Resource profile is not resolved");
    const assignment = RuntimeAssignmentSchema.parse({
      contractVersion: "scriptorium-platform/v1",
      instanceId: instance.instanceId,
      repositoryId: binding.repositoryId,
      repositoryLocator: `https://github.com/${binding.owner}/${binding.name}`,
      defaultBranchPolicy: policy.defaultBranchPolicy,
      runtimeEpoch,
      imageDigest: statement.artifact.digest,
      compositionManifestDigest: statement.compositionManifest.digest,
      enabledModuleIds: statement.resolvedModules.map((x) => x.id),
      credentialBrokerLocator: policy.credentialBrokerLocator,
      grantPolicy: { issuer: gateway, jwksUrl: `${gateway}/.well-known/jwks.json`, audience },
      controlServicePolicy: {
        issuer: control,
        jwksUrl: `${control}/.well-known/control-jwks.json`,
        audience: "praetorium-runtime-control",
      },
    });
    if (!/^[a-z0-9.-]+(?::[0-9]+)?$/.test(policy.registryHost))
      throw new Error("Invalid runtime registry host");
    return {
      revisionId: revision.revisionId,
      artifactRef: `${policy.registryHost}/${statement.artifact.repository}@${statement.artifact.digest}`,
      platformManifestDigest: statement.artifact.platformManifestDigest,
      resourceProfileId,
      hostname,
      resources: revision.resources,
      assignment,
      metadata,
      ...(persistence === undefined ? {} : { persistence }),
    };
  };
  return resolve(revision, runtimeEpoch);
}

export function resolveRuntimeContext(
  claim: ClaimedOperation,
  policy: RuntimeContextPolicy,
  persistenceByRevision: ReadonlyMap<string, PersistenceCompatibility> = new Map(),
) {
  const { instance } = claim.snapshot;
  const current = resolveAdmittedRuntime(
    claim.snapshot,
    claim.currentDeploymentRevision,
    instance.observedRuntimeEpoch,
    policy,
    claim.currentDeploymentRevision === null
      ? undefined
      : persistenceByRevision.get(claim.currentDeploymentRevision.revisionId),
  );
  const target =
    claim.operation.kind === "stop"
      ? null
      : resolveAdmittedRuntime(
          claim.snapshot,
          claim.deploymentRevision,
          claim.operation.runtimeEpoch,
          policy,
          claim.deploymentRevision === null
            ? undefined
            : persistenceByRevision.get(claim.deploymentRevision.revisionId),
        );
  if (claim.operation.kind !== "stop" && target === null)
    throw new Error("Target deployment is unavailable");
  if (
    instance.observedState !== "absent" &&
    instance.observedState !== "stopped" &&
    current === null
  )
    throw new Error("Current writer deployment is unknown");
  return { current, target };
}

/** Read compatibility only from the admitted, digest-addressed composition;
 * selection fields and runtime self-reports cannot assert image capabilities. */
export async function readAdmittedPersistence(
  revision: DeploymentRevisionSummary | null,
  registry: Pick<ArtifactRegistryProvider, "readBlob">,
): Promise<PersistenceCompatibility | undefined> {
  if (revision === null || revision.status !== "admitted" || revision.artifact === null)
    return undefined;
  const statement = BuilderArtifactStatementSchema.parse(revision.artifact.statement);
  const blob = await registry.readBlob(
    statement.compositionManifest.repository,
    statement.compositionManifest.digest,
    1024 * 1024,
  );
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(blob.bytes));
  const digest = `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (blob.digest !== statement.compositionManifest.digest || digest !== blob.digest)
    throw new Error("Composition digest mismatch");
  const manifest = CompositionManifestSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(blob.bytes)),
  );
  if (
    !(await validateCompositionBindings(manifest)) ||
    manifest.buildKey !== revision.buildKey ||
    statement.buildKey !== manifest.buildKey ||
    statement.producerRevision !== manifest.producerRevision ||
    statement.artifact.digest !== revision.artifactDigest ||
    statement.compositionManifest.digest !== revision.artifact.compositionManifestDigest ||
    JSON.stringify(statement.resolvedModules) !== JSON.stringify(manifest.resolvedModules)
  )
    throw new Error("Composition is not bound to admitted revision");
  return manifest.persistence;
}
