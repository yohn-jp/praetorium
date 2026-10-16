import {
  RuntimeAssignmentSchema,
  RuntimeMetadataSchema,
  RuntimeStatusSchema,
  type RuntimeAssignment,
  type RuntimeMetadata,
  type RuntimeStatus,
} from "@praetorium/contracts";

export interface RuntimeApplicationRequirements {
  readonly httpPort: number;
  readonly livenessPath: string;
  readonly readinessPath: string;
  readonly metadataPath: string;
  readonly shutdownPath: string;
  readonly shutdownTimeoutSeconds: number;
  readonly platformControlPaths: {
    readonly status: string;
    readonly quiesce: string;
    readonly resume: string;
  };
}

export interface RuntimeAuthenticationPolicy {
  readonly grantVerifier: RuntimeAssignment["grantPolicy"];
  readonly controlServiceVerifier: RuntimeAssignment["controlServicePolicy"];
}

/** Map only producer-declared runtime values; no source-image defaults are used. */
export function runtimeApplicationRequirements(metadataInput: unknown): RuntimeApplicationRequirements {
  const metadata: RuntimeMetadata = RuntimeMetadataSchema.parse(metadataInput);
  return {
    httpPort: metadata.listener.port,
    livenessPath: metadata.paths.liveness,
    readinessPath: metadata.paths.readiness,
    metadataPath: metadata.paths.metadata,
    shutdownPath: metadata.paths.shutdown,
    shutdownTimeoutSeconds: metadata.shutdownTimeoutSeconds,
    platformControlPaths: {
      status: metadata.paths.status,
      quiesce: metadata.paths.quiesce,
      resume: metadata.paths.resume,
    },
  };
}

/**
 * Return the assignment's expected verifier policies for external probe setup.
 * This configuration does not prove either verifier is active or correct.
 */
export function runtimeAuthenticationPolicy(assignmentInput: unknown): RuntimeAuthenticationPolicy {
  const assignment: RuntimeAssignment = RuntimeAssignmentSchema.parse(assignmentInput);
  return {
    grantVerifier: assignment.grantPolicy,
    controlServiceVerifier: assignment.controlServicePolicy,
  };
}

/**
 * Check the application's status identity against its trusted assignment.
 * The image field is only producer self-report and requires independent
 * registry/CRI observation before artifact identity can be certified.
 */
export function assertRuntimeStatusBoundToAssignment(
  assignmentInput: unknown,
  statusInput: unknown,
): RuntimeStatus {
  const assignment: RuntimeAssignment = RuntimeAssignmentSchema.parse(assignmentInput);
  const status: RuntimeStatus = RuntimeStatusSchema.parse(statusInput);
  const expectedModules = [...assignment.enabledModuleIds].sort();
  const reportedModules = [...status.enabledModuleIds].sort();
  if (
    status.instanceId !== assignment.instanceId ||
    status.repositoryId !== assignment.repositoryId ||
    status.runtimeEpoch !== assignment.runtimeEpoch ||
    status.imageDigest !== assignment.imageDigest ||
    status.compositionManifestDigest !== assignment.compositionManifestDigest ||
    expectedModules.length !== reportedModules.length ||
    expectedModules.some((id, index) => id !== reportedModules[index])
  ) {
    throw new TypeError("Scriptorium runtime status does not match its assignment");
  }
  return status;
}
