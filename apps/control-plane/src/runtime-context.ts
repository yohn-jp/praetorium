import {
  BuilderArtifactStatementSchema,
  RuntimeAssignmentSchema,
  RuntimeMetadataSchema,
  instanceHostname,
} from "@praetorium/contracts";
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
    };
  };
  return resolve(revision, runtimeEpoch);
}

export function resolveRuntimeContext(claim: ClaimedOperation, policy: RuntimeContextPolicy) {
  const { instance } = claim.snapshot;
  const current = resolveAdmittedRuntime(
    claim.snapshot,
    claim.currentDeploymentRevision,
    instance.observedRuntimeEpoch,
    policy,
  );
  const target =
    claim.operation.kind === "stop"
      ? null
      : resolveAdmittedRuntime(
          claim.snapshot,
          claim.deploymentRevision,
          claim.operation.runtimeEpoch,
          policy,
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
