import { RuntimeAssignmentSchema, type RuntimeAssignment as ScriptoriumRuntimeAssignment } from "@praetorium/contracts";
import type { RuntimeAssignment } from "@praetorium/application/lifecycle";
import type {
  ClaimedProvisionerOperation,
  RuntimeIdentityProvisionerService,
  RuntimeBindingMetadata,
} from "./operation-client.js";

const CACHE_REFRESH_MARGIN_MS = 60_000;
const MAX_PROOF_LIFETIME_MS = 300_000;

export interface RuntimeIdentityMaterial {
  readonly assignment: ScriptoriumRuntimeAssignment;
  readonly proof: string;
  readonly expiresAt: string;
}

export interface RuntimeIdentityAssignmentTransportOptions {
  readonly operations: RuntimeIdentityProvisionerService;
  readonly workerId: string;
  readonly clusterId: string;
  readonly claim?: ClaimedProvisionerOperation;
  readonly now?: () => number;
}

/** Maps the admitted lifecycle runtime into Scriptorium's canonical assignment
 * and obtains a short-lived proof from the Provisioner-authenticated issuer. */
export class RuntimeIdentityAssignmentTransport {
  readonly available = true;
  private readonly now: () => number;
  private readonly cache = new Map<string, RuntimeIdentityMaterial>();

  constructor(private readonly options: RuntimeIdentityAssignmentTransportOptions) {
    this.now = options.now ?? Date.now;
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(options.workerId))
      throw new TypeError("runtime identity worker ID is invalid");
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(options.clusterId))
      throw new TypeError("runtime identity cluster ID is invalid");
  }

  forClaim(claim: ClaimedProvisionerOperation): RuntimeIdentityAssignmentTransport {
    return new RuntimeIdentityAssignmentTransport({
      operations: this.options.operations,
      workerId: this.options.workerId,
      clusterId: this.options.clusterId,
      claim,
      now: this.now,
    });
  }

  canonicalAssignment(assignment: RuntimeAssignment): ScriptoriumRuntimeAssignment {
    return RuntimeAssignmentSchema.parse({
      contractVersion: "scriptorium-platform/v1",
      instanceId: assignment.instanceId,
      repositoryId: assignment.repositoryId,
      repositoryLocator: assignment.deployment.repositoryLocator,
      defaultBranchPolicy: assignment.deployment.defaultBranchPolicy,
      runtimeEpoch: assignment.runtimeEpoch,
      imageDigest: assignment.deployment.imageDigest,
      compositionManifestDigest: assignment.deployment.compositionManifestDigest,
      enabledModuleIds: [...assignment.deployment.enabledModuleIds],
      credentialBrokerLocator: assignment.deployment.credentialBrokerLocator,
      grantPolicy: assignment.deployment.grantPolicy,
      controlServicePolicy: assignment.deployment.controlServicePolicy,
    });
  }

  async project(
    assignment: RuntimeAssignment,
    signal?: AbortSignal,
  ): Promise<RuntimeIdentityMaterial> {
    if (assignment.clusterId !== this.options.clusterId)
      throw new TypeError("runtime identity assignment belongs to another cluster");
    const canonical = this.canonicalAssignment(assignment);
    const key = JSON.stringify(canonical);
    const cached = this.cache.get(key);
    if (cached !== undefined && Date.parse(cached.expiresAt) - this.now() > CACHE_REFRESH_MARGIN_MS) {
      return cached;
    }

    const binding = await this.options.operations.readRuntimeBinding({
      repositoryId: assignment.repositoryId,
      ...(signal === undefined ? {} : { signal }),
    });
    if (binding === null || !bindingMatches(binding, assignment, this.options.clusterId))
      throw new Error("runtime_identity_binding_unavailable_or_mismatched");

    const claim = this.options.claim;
    if (claim !== undefined && claim.snapshot.binding.installationId !== binding.installationId)
      throw new Error("runtime_identity_installation_binding_changed");
    if (binding.authority === "post-absence-target" && claim === undefined)
      throw new Error("runtime_identity_target_requires_operation_lease");
    if (claim !== undefined &&
        (claim.operation.instanceId !== assignment.instanceId ||
          claim.operation.repositoryId !== assignment.repositoryId ||
          claim.operation.clusterId !== assignment.clusterId ||
          claim.snapshot.binding.installationId !== binding.installationId)) {
      throw new Error("runtime_identity_operation_binding_mismatch");
    }

    const request = {
      runtimeId: binding.runtimeId,
      instanceId: binding.instanceId,
      repositoryId: binding.repositoryId,
      installationId: binding.installationId,
      runtimeEpoch: binding.runtimeEpoch,
      leaseId: binding.leaseId,
      workerId: this.options.workerId,
      clusterId: binding.clusterId,
      ...(binding.authority === "post-absence-target" && claim !== undefined
        ? {
            operationId: claim.operation.id,
            leaseToken: claim.operation.leaseToken,
            leaseEpoch: claim.operation.leaseEpoch,
          }
        : {}),
      ...(signal === undefined ? {} : { signal }),
    };
    const issued = await this.options.operations.issueRuntimeIdentity(request);
    const now = this.now();
    const expiresAtMs = Date.parse(issued.expiresAt);
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= now ||
      expiresAtMs > now + MAX_PROOF_LIFETIME_MS ||
      issued.token.length < 16 ||
      issued.token.length > 4_096 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(issued.token)
    ) {
      throw new TypeError("runtime identity issuer returned an invalid proof");
    }
    const material = { assignment: canonical, proof: issued.token, expiresAt: issued.expiresAt };
    this.cache.set(key, material);
    return material;
  }

  invalidate(assignment: RuntimeAssignment): void {
    this.cache.delete(JSON.stringify(this.canonicalAssignment(assignment)));
  }
}

function bindingMatches(
  binding: RuntimeBindingMetadata,
  assignment: RuntimeAssignment,
  clusterId: string,
): boolean {
  return (
    binding.active === true &&
    binding.repositoryId === assignment.repositoryId &&
    binding.instanceId === assignment.instanceId &&
    binding.runtimeEpoch === assignment.runtimeEpoch &&
    binding.clusterId === clusterId &&
    binding.runtimeId.length > 0 &&
    binding.leaseId.length > 0
  );
}
