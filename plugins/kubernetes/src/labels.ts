import { RuntimeProviderError } from "./errors.js";
import type { RuntimeInstanceId, RuntimeReleaseId, RuntimeRepositoryId } from "./types.js";

export const PLATFORM_LABEL_KEY = "arcadia.io/platform";
export const INSTANCE_LABEL_KEY = "arcadia.io/instance-id";
export const REPOSITORY_LABEL_KEY = "praetorium.io/repository-id";
export const RUNTIME_EPOCH_LABEL_KEY = "praetorium.io/runtime-epoch";
export const GENERATION_LABEL_KEY = "arcadia.io/generation";
export const RELEASE_LABEL_KEY = "arcadia.io/release-id";
export const OWNERSHIP_LABEL_KEY = "arcadia.io/ownership-version";
export const CLUSTER_LABEL_KEY = "arcadia.io/runtime-cluster-id";
export const MANAGED_BY_LABEL_KEY = "app.kubernetes.io/managed-by";

export const PLATFORM_LABEL_VALUE = "arcadia-platform";
export const MANAGED_BY_LABEL_VALUE = "arcadia-provisioner";
export const OWNERSHIP_VERSION = "v1";
export const NO_RELEASE_LABEL_VALUE = "none";

export interface ManagedLabelInput {
  readonly instanceId: RuntimeInstanceId;
  readonly repositoryId: RuntimeRepositoryId;
  readonly runtimeEpoch: number;
  readonly generation: number;
  readonly releaseId: RuntimeReleaseId | null;
}

export function managedLabels(input: ManagedLabelInput): Readonly<Record<string, string>> {
  if (
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !Number.isSafeInteger(input.runtimeEpoch) ||
    input.runtimeEpoch < 1
  ) {
    throw new RuntimeProviderError("invalid_spec", "runtime generation is invalid", "terminal");
  }
  const labels = {
    [PLATFORM_LABEL_KEY]: PLATFORM_LABEL_VALUE,
    [MANAGED_BY_LABEL_KEY]: MANAGED_BY_LABEL_VALUE,
    [INSTANCE_LABEL_KEY]: input.instanceId,
    [REPOSITORY_LABEL_KEY]: String(input.repositoryId),
    [RUNTIME_EPOCH_LABEL_KEY]: String(input.runtimeEpoch),
    [GENERATION_LABEL_KEY]: String(input.generation),
    [RELEASE_LABEL_KEY]: input.releaseId ?? NO_RELEASE_LABEL_VALUE,
    [OWNERSHIP_LABEL_KEY]: OWNERSHIP_VERSION,
  };
  for (const value of Object.values(labels)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,61}[A-Za-z0-9]$|^[A-Za-z0-9]$/.test(value)) {
      throw new RuntimeProviderError("invalid_spec", "managed label value is invalid", "terminal");
    }
  }
  return labels;
}

export function managedLabelSelector(): string {
  return `${PLATFORM_LABEL_KEY}=${PLATFORM_LABEL_VALUE},${OWNERSHIP_LABEL_KEY}=${OWNERSHIP_VERSION}`;
}

export function assertManagedLabels(
  labels: Readonly<Record<string, string>>,
  expected: Partial<ManagedLabelInput> & {
    readonly instanceId: RuntimeInstanceId;
    readonly repositoryId: RuntimeRepositoryId;
    readonly runtimeEpoch: number;
  },
): void {
  const required = {
    [PLATFORM_LABEL_KEY]: PLATFORM_LABEL_VALUE,
    [MANAGED_BY_LABEL_KEY]: MANAGED_BY_LABEL_VALUE,
    [INSTANCE_LABEL_KEY]: expected.instanceId,
    [REPOSITORY_LABEL_KEY]: String(expected.repositoryId),
    [RUNTIME_EPOCH_LABEL_KEY]: String(expected.runtimeEpoch),
    [OWNERSHIP_LABEL_KEY]: OWNERSHIP_VERSION,
    ...(expected.generation === undefined
      ? {}
      : { [GENERATION_LABEL_KEY]: String(expected.generation) }),
    ...(expected.releaseId === undefined
      ? {}
      : { [RELEASE_LABEL_KEY]: expected.releaseId ?? NO_RELEASE_LABEL_VALUE }),
  };
  for (const [key, value] of Object.entries(required)) {
    if (labels[key] !== value) {
      throw new RuntimeProviderError(
        "invalid_response",
        "managed object ownership labels are invalid",
        "terminal",
      );
    }
  }
}
