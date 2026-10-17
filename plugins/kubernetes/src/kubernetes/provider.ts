import { createHash } from "node:crypto";
import { RuntimeProviderError } from "../errors.js";
import {
  CLUSTER_LABEL_KEY,
  GENERATION_LABEL_KEY,
  INSTANCE_LABEL_KEY,
  MANAGED_BY_LABEL_KEY,
  MANAGED_BY_LABEL_VALUE,
  NO_RELEASE_LABEL_VALUE,
  OWNERSHIP_LABEL_KEY,
  OWNERSHIP_VERSION,
  PLATFORM_LABEL_KEY,
  PLATFORM_LABEL_VALUE,
  RELEASE_LABEL_KEY,
  REPOSITORY_LABEL_KEY,
  RUNTIME_EPOCH_LABEL_KEY,
  managedLabelSelector,
  managedLabels,
} from "../labels.js";
import { runtimeNamespaceName, runtimeResourceName, validateNamespace } from "../naming.js";
import type {
  ApplyResult,
  InstanceIdentity,
  ManagedRuntimeSummary,
  ReleaseSpec,
  RuntimeCondition,
  RuntimeDeletionSpec,
  RuntimeEffectGuard,
  RuntimeEndpointActivationEvidence,
  RuntimeNeutralState,
  RuntimeObservation,
  RuntimePage,
  RuntimeProvider,
  RuntimeResourceProfile,
  RuntimeResourceQuantities,
  RunningInstanceSpec,
  StoppedInstanceSpec,
  RuntimeWriterCensus,
  RuntimeWriterPodIdentity,
} from "../types.js";
import {
  parseRuntimeInstanceId,
  parseRuntimeReleaseId,
  parseRuntimeRepositoryId,
} from "../types.js";
import { createInClusterKubernetesApi, KubernetesApiError, type KubernetesApi } from "./client.js";
import { mapKubernetesError } from "./error-mapper.js";
import {
  KUBERNETES_RESOURCE_KINDS,
  type KubernetesNamespace,
  type KubernetesObjectPreconditions,
  type KubernetesResource,
  type KubernetesResourceKind,
  type KubernetesReadableResourceKind,
  type KubernetesResourceRenderer,
} from "./types.js";
import {
  createKubernetesResourceRenderer,
  type KubernetesResourceRendererOptions,
} from "./renderer.js";
import type {
  KubernetesCapacityReservation,
  KubernetesCapacityReservationSource,
} from "./capacity.js";

export const KUBERNETES_FIELD_MANAGER = "arcadia-provisioner";

const API_VERSIONS: Readonly<Record<KubernetesResourceKind, string>> = {
  ConfigMap: "v1",
  Deployment: "apps/v1",
  IngressRoute: "traefik.io/v1alpha1",
  LimitRange: "v1",
  NetworkPolicy: "networking.k8s.io/v1",
  ResourceQuota: "v1",
  RoleBinding: "rbac.authorization.k8s.io/v1",
  Secret: "v1",
  ServiceAccount: "v1",
  Service: "v1",
};

const PROVISIONER_NAMESPACE = "praetorium-system";
const PROVISIONER_SERVICE_ACCOUNT = "praetorium-provisioner";
const PROVISIONER_TENANT_ROLE = "praetorium-provisioner-tenant-runtime";
const MAX_LIST_PAGES = 1_000;
const MAX_TENANT_PODS = 10_000;

export interface KubernetesRuntimeProviderOptions {
  readonly api: KubernetesApi;
  readonly namespacePrefix: string;
  readonly clusterId: string;
  readonly renderer: KubernetesResourceRenderer;
  readonly reservations: KubernetesCapacityReservationSource;
  readonly now?: () => number;
  readonly maxCapacityAgeMs: number;
  readonly maxActivationEvidenceAgeMs?: number;
}

export interface InClusterKubernetesRuntimeProviderOptions
  extends Omit<KubernetesRuntimeProviderOptions, "api" | "renderer"> {
  readonly rendererOptions: Omit<
    KubernetesResourceRendererOptions,
    "namespacePrefix" | "clusterId"
  >;
}

interface ObjectMetadata {
  readonly name: string;
  readonly namespace: string | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly deleting: boolean;
  readonly uid: string | null;
  readonly resourceVersion: string | null;
}

interface NamespaceMetadata {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly deleting: boolean;
  readonly uid: string | null;
  readonly resourceVersion: string | null;
}

interface PodListSnapshot {
  readonly items: readonly unknown[];
  readonly resourceVersion: string;
}

interface ParsedPodEvidence extends RuntimeWriterPodIdentity {
  readonly ownershipValid: boolean;
  readonly applicationImageDigest?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function labelsOf(value: unknown): Readonly<Record<string, string>> {
  const source = record(record(value)?.metadata)?.labels;
  const labels = record(source);
  if (labels === undefined) {
    throw new RuntimeProviderError(
      "invalid_response",
      "Kubernetes object labels are missing",
      "retryable",
    );
  }
  const result: Record<string, string> = {};
  for (const [key, label] of Object.entries(labels)) {
    if (typeof label !== "string") {
      throw new RuntimeProviderError(
        "invalid_response",
        "Kubernetes object labels are invalid",
        "retryable",
      );
    }
    result[key] = label;
  }
  return result;
}

function objectMetadata(value: unknown): ObjectMetadata {
  const metadata = record(record(value)?.metadata);
  const name = stringValue(metadata?.name);
  if (name === null) {
    throw new RuntimeProviderError(
      "invalid_response",
      "Kubernetes object metadata is invalid",
      "retryable",
    );
  }
  const annotations: Record<string, string> = {};
  for (const [key, annotation] of Object.entries(record(metadata?.annotations) ?? {})) {
    if (typeof annotation === "string") annotations[key] = annotation;
  }
  return {
    name,
    namespace: stringValue(metadata?.namespace),
    labels: labelsOf(value),
    annotations,
    deleting: typeof metadata?.deletionTimestamp === "string",
    uid: stringValue(metadata?.uid),
    resourceVersion: stringValue(metadata?.resourceVersion),
  };
}

function namespaceMetadata(value: unknown): NamespaceMetadata {
  const metadata = record(record(value)?.metadata);
  const name = stringValue(metadata?.name);
  if (name === null) {
    throw new RuntimeProviderError(
      "invalid_response",
      "Kubernetes namespace metadata is invalid",
      "retryable",
    );
  }
  return {
    name,
    labels: labelsOf(value),
    deleting: typeof metadata?.deletionTimestamp === "string",
    uid: stringValue(metadata?.uid),
    resourceVersion: stringValue(metadata?.resourceVersion),
  };
}

function preconditions(metadata: ObjectMetadata): KubernetesObjectPreconditions {
  if (metadata.uid === null || metadata.resourceVersion === null) {
    throw new RuntimeProviderError(
      "invalid_response",
      "Kubernetes object preconditions are missing",
      "retryable",
    );
  }
  return { uid: metadata.uid, resourceVersion: metadata.resourceVersion };
}

function validateIdentity(identity: InstanceIdentity, clusterId: string): void {
  if (
    identity.clusterId !== clusterId ||
    !Number.isSafeInteger(identity.runtimeEpoch) ||
    identity.runtimeEpoch < 1 ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 1
  ) {
    throw new RuntimeProviderError(
      "invalid_spec",
      "runtime identity is invalid for this cluster",
      "terminal",
    );
  }
  try {
    parseRuntimeInstanceId(identity.instanceId);
    parseRuntimeRepositoryId(identity.repositoryId);
  } catch {
    throw new RuntimeProviderError("invalid_spec", "runtime identity is invalid", "terminal");
  }
}

function resourceLabels(
  identity: InstanceIdentity,
  releaseId: string | null,
): Readonly<Record<string, string>> {
  return {
    ...managedLabels({
      instanceId: identity.instanceId,
      repositoryId: identity.repositoryId,
      runtimeEpoch: identity.runtimeEpoch,
      generation: identity.generation,
      releaseId: releaseId === null ? null : parseRuntimeReleaseId(releaseId),
    }),
    [CLUSTER_LABEL_KEY]: identity.clusterId,
  };
}

function namespaceOwnershipLabels(identity: InstanceIdentity): Readonly<Record<string, string>> {
  return {
    [PLATFORM_LABEL_KEY]: PLATFORM_LABEL_VALUE,
    [MANAGED_BY_LABEL_KEY]: MANAGED_BY_LABEL_VALUE,
    [INSTANCE_LABEL_KEY]: identity.instanceId,
    [REPOSITORY_LABEL_KEY]: String(identity.repositoryId),
    [OWNERSHIP_LABEL_KEY]: OWNERSHIP_VERSION,
    [CLUSTER_LABEL_KEY]: identity.clusterId,
  };
}

const RESTRICTED_POD_SECURITY_LABELS = {
  "pod-security.kubernetes.io/enforce": "restricted",
  "pod-security.kubernetes.io/audit": "restricted",
  "pod-security.kubernetes.io/warn": "restricted",
} as const;
const POD_SECURITY_MODES = ["enforce", "audit", "warn"] as const;

function namespaceLabels(identity: InstanceIdentity): Readonly<Record<string, string>> {
  return {
    ...namespaceOwnershipLabels(identity),
    ...RESTRICTED_POD_SECURITY_LABELS,
  };
}

function podSecurityVersionsAreCurrent(labels: Readonly<Record<string, string>>): boolean {
  return POD_SECURITY_MODES.every((mode) => {
    const version = labels[`pod-security.kubernetes.io/${mode}-version`];
    return version === undefined || version === "latest";
  });
}

function assertNamespaceOwned(
  value: unknown,
  identity: InstanceIdentity,
  namespaceName: string,
): NamespaceMetadata {
  const metadata = namespaceMetadata(value);
  const expected = namespaceLabels(identity);
  if (
    metadata.name !== namespaceName ||
    !podSecurityVersionsAreCurrent(metadata.labels) ||
    Object.entries(expected).some(([key, val]) => metadata.labels[key] !== val)
  ) {
    throw new RuntimeProviderError(
      "conflict",
      "runtime namespace ownership does not match",
      "terminal",
    );
  }
  return metadata;
}

function assertObjectOwned(
  value: unknown,
  identity: InstanceIdentity,
  namespaceName: string,
  expectedName?: string,
): ObjectMetadata {
  const metadata = objectMetadata(value);
  const expected = namespaceOwnershipLabels(identity);
  if (
    metadata.namespace !== namespaceName ||
    (expectedName !== undefined && metadata.name !== expectedName) ||
    Object.entries(expected).some(([key, val]) => metadata.labels[key] !== val)
  ) {
    throw new RuntimeProviderError(
      "conflict",
      "runtime resource ownership does not match",
      "terminal",
    );
  }
  return metadata;
}

function parsePositiveLabel(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function identityFromLabels(
  labels: Readonly<Record<string, string>>,
  clusterId: string,
): InstanceIdentity | null {
  if (
    labels[PLATFORM_LABEL_KEY] !== PLATFORM_LABEL_VALUE ||
    labels[MANAGED_BY_LABEL_KEY] !== MANAGED_BY_LABEL_VALUE ||
    labels[OWNERSHIP_LABEL_KEY] !== OWNERSHIP_VERSION ||
    labels[CLUSTER_LABEL_KEY] !== clusterId
  )
    return null;
  const instance = labels[INSTANCE_LABEL_KEY];
  const repository = Number(labels[REPOSITORY_LABEL_KEY]);
  const runtimeEpoch = parsePositiveLabel(labels[RUNTIME_EPOCH_LABEL_KEY]);
  const generation = parsePositiveLabel(labels[GENERATION_LABEL_KEY]);
  if (instance === undefined || runtimeEpoch === null || generation === null) return null;
  try {
    return {
      instanceId: parseRuntimeInstanceId(instance),
      repositoryId: parseRuntimeRepositoryId(repository),
      runtimeEpoch,
      generation,
      clusterId,
    };
  } catch {
    return null;
  }
}

function assertNotNewerThan(
  current: Readonly<Record<string, string>>,
  identity: InstanceIdentity,
): void {
  const currentEpoch = parsePositiveLabel(current[RUNTIME_EPOCH_LABEL_KEY]);
  const currentGeneration = parsePositiveLabel(current[GENERATION_LABEL_KEY]);
  if (currentEpoch === null || currentGeneration === null) {
    throw new RuntimeProviderError(
      "invalid_response",
      "managed runtime epoch or generation is invalid",
      "terminal",
    );
  }
  if (
    currentEpoch > identity.runtimeEpoch ||
    (currentEpoch === identity.runtimeEpoch && currentGeneration > identity.generation)
  ) {
    throw new RuntimeProviderError(
      "conflict",
      "runtime has a newer epoch or generation",
      "retryable",
    );
  }
}

function targetMatches(metadata: ObjectMetadata, identity: InstanceIdentity): boolean {
  const labels = metadata.labels;
  return (
    labels[INSTANCE_LABEL_KEY] === identity.instanceId &&
    labels[REPOSITORY_LABEL_KEY] === String(identity.repositoryId) &&
    labels[CLUSTER_LABEL_KEY] === identity.clusterId &&
    labels[RUNTIME_EPOCH_LABEL_KEY] === String(identity.runtimeEpoch) &&
    labels[GENERATION_LABEL_KEY] === String(identity.generation)
  );
}

function sameIdentity(left: InstanceIdentity, right: InstanceIdentity): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.repositoryId === right.repositoryId &&
    left.runtimeEpoch === right.runtimeEpoch &&
    left.generation === right.generation &&
    left.clusterId === right.clusterId
  );
}

function digestFromImageId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /sha256:[0-9a-f]{64}$/.exec(value)?.[0];
}

function podEvidence(
  value: unknown,
  namespaceName: string,
  identity: InstanceIdentity,
): ParsedPodEvidence {
  const metadata = objectMetadata(value);
  if (metadata.namespace !== namespaceName || metadata.uid === null) {
    throw new RuntimeProviderError(
      "invalid_response",
      "Kubernetes Pod identity is incomplete",
      "retryable",
    );
  }
  const podIdentity = identityFromLabels(metadata.labels, identity.clusterId);
  const ownershipValid =
    podIdentity !== null &&
    podIdentity.instanceId === identity.instanceId &&
    podIdentity.repositoryId === identity.repositoryId;
  const status = record(record(value)?.status);
  const conditions = Array.isArray(status?.conditions) ? status.conditions : [];
  const ready = conditions.some((condition) => {
    const item = record(condition);
    return item?.type === "Ready" && item.status === "True";
  });
  const statuses = Array.isArray(status?.containerStatuses) ? status.containerStatuses : [];
  const imageIds = statuses.flatMap((item): string[] => {
    const imageId = stringValue(record(item)?.imageID);
    return imageId === null ? [] : [imageId];
  });
  const applicationStatus = statuses.find((item) => record(item)?.name === "scriptorium");
  const applicationImageDigest = digestFromImageId(record(applicationStatus)?.imageID);
  return {
    namespace: metadata.namespace,
    name: metadata.name,
    uid: metadata.uid,
    runtimeEpoch: parsePositiveLabel(metadata.labels[RUNTIME_EPOCH_LABEL_KEY]),
    generation: parsePositiveLabel(metadata.labels[GENERATION_LABEL_KEY]),
    phase: stringValue(status?.phase),
    deleting: metadata.deleting,
    ready,
    imageIds,
    ownershipValid,
    ...(applicationImageDigest === undefined ? {} : { applicationImageDigest }),
  };
}

function deploymentConditions(value: unknown): readonly RuntimeCondition[] {
  const conditions = record(record(value)?.status)?.conditions;
  if (!Array.isArray(conditions)) return [];
  return conditions.flatMap((condition): RuntimeCondition[] => {
    const item = record(condition);
    if (item === undefined || typeof item.type !== "string") return [];
    const status = item.status === "True" ? "true" : item.status === "False" ? "false" : "unknown";
    return [
      {
        type: item.type,
        status,
        ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
      },
    ];
  });
}

function releaseIdFromLabels(labels: Readonly<Record<string, string>>) {
  const releaseId = labels[RELEASE_LABEL_KEY];
  if (releaseId === undefined || releaseId === NO_RELEASE_LABEL_VALUE) return undefined;
  try {
    return parseRuntimeReleaseId(releaseId);
  } catch {
    throw new RuntimeProviderError(
      "invalid_response",
      "runtime release identity is invalid",
      "retryable",
    );
  }
}

function optionalApiNotFound(error: unknown): boolean {
  return error instanceof KubernetesApiError && error.statusCode === 404;
}

async function listAllPods(
  api: KubernetesApi,
  namespaceName: string,
  signal?: AbortSignal,
): Promise<PodListSnapshot> {
  const items: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let resourceVersion: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber += 1) {
    const page = await api
      .list("Pod", namespaceName, "", cursor, signal)
      .catch((error: unknown) => {
        throw mapKubernetesError(error);
      });
    if (
      page.resourceVersion === null ||
      (resourceVersion !== null && resourceVersion !== page.resourceVersion)
    ) {
      throw new RuntimeProviderError(
        "unavailable",
        "Pod census is not a complete consistent snapshot",
        "retryable",
      );
    }
    resourceVersion = page.resourceVersion;
    items.push(...page.items);
    if (items.length > MAX_TENANT_PODS) {
      throw new RuntimeProviderError(
        "unavailable",
        "Pod census exceeded its safety bound",
        "retryable",
      );
    }
    if (page.nextCursor === null) return { items, resourceVersion };
    if (cursors.has(page.nextCursor)) {
      throw new RuntimeProviderError(
        "unavailable",
        "Pod census pagination did not advance",
        "retryable",
      );
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new RuntimeProviderError("unavailable", "Pod census exceeded its page bound", "retryable");
}

function validateRelease(spec: RunningInstanceSpec | ReleaseSpec): void {
  if (
    !/^sha256:[0-9a-f]{64}$/.test(spec.release.imageDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(spec.release.platformManifestDigest) ||
    !/^[a-z0-9][a-z0-9./:_-]{0,254}@sha256:[0-9a-f]{64}$/.test(spec.release.artifactRef) ||
    !spec.release.artifactRef.endsWith("@" + spec.release.imageDigest)
  ) {
    throw new RuntimeProviderError(
      "invalid_spec",
      "an admitted immutable runtime artifact is required",
      "terminal",
    );
  }
}

function appContainerImage(value: unknown): string | null {
  const template = record(record(record(value)?.spec)?.template);
  const podSpec = record(template?.spec);
  const containers = Array.isArray(podSpec?.containers) ? podSpec.containers : [];
  const app = containers.find((container) => record(container)?.name === "scriptorium");
  return stringValue(record(app)?.image);
}

function resourceRequestFits(
  requested: RuntimeResourceQuantities,
  available: RuntimeResourceQuantities,
): boolean {
  return (
    requested.cpuMilli <= available.cpuMilli &&
    requested.memoryMiB <= available.memoryMiB &&
    requested.ephemeralStorageMiB <= available.ephemeralStorageMiB
  );
}

function minusFloor(
  left: RuntimeResourceQuantities,
  right: RuntimeResourceQuantities,
): RuntimeResourceQuantities {
  return {
    cpuMilli: Math.max(0, left.cpuMilli - right.cpuMilli),
    memoryMiB: Math.max(0, left.memoryMiB - right.memoryMiB),
    ephemeralStorageMiB: Math.max(0, left.ephemeralStorageMiB - right.ephemeralStorageMiB),
  };
}

function validateProfile(profile: RuntimeResourceProfile): void {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(profile.id)) {
    throw new RuntimeProviderError(
      "invalid_spec",
      "runtime resource profile id is invalid",
      "terminal",
    );
  }
  for (const amount of Object.values(profile.request)) {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new RuntimeProviderError(
        "invalid_spec",
        "runtime resource profile is invalid",
        "terminal",
      );
    }
  }
}

export class KubernetesRuntimeProvider implements RuntimeProvider {
  private readonly namespacePrefix: string;
  private readonly now: () => number;
  private readonly maxActivationEvidenceAgeMs: number;

  constructor(private readonly options: KubernetesRuntimeProviderOptions) {
    this.namespacePrefix = validateNamespace(options.namespacePrefix);
    if (!/^clu_[0-9A-HJKMNP-TV-Z]{26}$/.test(options.clusterId)) {
      throw new RuntimeProviderError("invalid_spec", "runtime cluster id is invalid", "terminal");
    }
    if (!Number.isSafeInteger(options.maxCapacityAgeMs) || options.maxCapacityAgeMs < 1) {
      throw new RuntimeProviderError(
        "misconfigured",
        "capacity freshness bound is invalid",
        "terminal",
      );
    }
    this.maxActivationEvidenceAgeMs = options.maxActivationEvidenceAgeMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.maxActivationEvidenceAgeMs) ||
      this.maxActivationEvidenceAgeMs < 1
    ) {
      throw new RuntimeProviderError(
        "misconfigured",
        "endpoint evidence freshness bound is invalid",
        "terminal",
      );
    }
    this.now = options.now ?? Date.now;
  }

  async inspect(identity: InstanceIdentity, signal?: AbortSignal): Promise<RuntimeObservation> {
    validateIdentity(identity, this.options.clusterId);
    const namespaceName = this.namespaceFor(identity.instanceId);
    const namespaceValue = await this.getNamespaceOptional(namespaceName, signal);
    if (namespaceValue === undefined) return this.absentObservation(identity, namespaceName);
    const namespace = assertNamespaceOwned(namespaceValue, identity, namespaceName);
    const podList = await listAllPods(this.options.api, namespaceName, signal);
    const pods = podList.items.map((pod) => podEvidence(pod, namespaceName, identity));
    const census: RuntimeWriterCensus = {
      scope: "instance-repository-all-epochs",
      complete: true,
      queriedNamespace: namespaceName,
      namespaceUid: namespace.uid,
      namespaceResourceVersion: namespace.resourceVersion,
      listResourceVersion: podList.resourceVersion,
      queriedPodCount: pods.length,
      pods: pods.map((pod) => ({
        namespace: pod.namespace,
        name: pod.name,
        uid: pod.uid,
        runtimeEpoch: pod.runtimeEpoch,
        generation: pod.generation,
        phase: pod.phase,
        deleting: pod.deleting,
        ready: pod.ready,
        imageIds: pod.imageIds,
      })),
    };

    const deploymentName = runtimeResourceName(identity.instanceId);
    const deployment = await this.getOptional(
      { kind: "Deployment", namespace: namespaceName, name: deploymentName },
      signal,
    );
    let deploymentMetadata: ObjectMetadata | undefined;
    let managedIdentity: InstanceIdentity | undefined;
    let releaseId: ReturnType<typeof parseRuntimeReleaseId> | undefined;
    let releaseDigest: string | undefined;
    if (deployment !== undefined) {
      deploymentMetadata = assertObjectOwned(deployment, identity, namespaceName, deploymentName);
      managedIdentity =
        identityFromLabels(deploymentMetadata.labels, this.options.clusterId) ?? undefined;
      if (managedIdentity === undefined) {
        throw new RuntimeProviderError(
          "invalid_response",
          "managed Deployment epoch or generation is invalid",
          "retryable",
        );
      }
      releaseId = releaseIdFromLabels(deploymentMetadata.labels);
      const digest = deploymentMetadata.annotations["arcadia.io/release-digest"];
      if (digest !== undefined && /^sha256:[0-9a-f]{64}$/.test(digest)) releaseDigest = digest;
    }

    const state = namespace.deleting
      ? "deleting"
      : this.observedState(deployment, pods, deploymentMetadata);
    const observedAt = this.now();
    const observationIdentity = managedIdentity ?? identity;
    const route = await this.getOptional(
      { kind: "IngressRoute", namespace: namespaceName, name: deploymentName },
      signal,
    );
    let endpoint: string | undefined;
    if (route !== undefined) {
      const routeMetadata = assertObjectOwned(route, identity, namespaceName, deploymentName);
      const routeIdentity = identityFromLabels(routeMetadata.labels, this.options.clusterId);
      if (routeIdentity === null) {
        throw new RuntimeProviderError(
          "invalid_response",
          "managed endpoint epoch or generation is invalid",
          "retryable",
        );
      }
      if (
        managedIdentity !== undefined &&
        routeIdentity.runtimeEpoch === managedIdentity.runtimeEpoch &&
        routeIdentity.generation === managedIdentity.generation
      ) {
        const host = this.observedEndpointHost(route, managedIdentity);
        if (host !== undefined) endpoint = "https://" + host;
      }
    }
    const observationId = createHash("sha256")
      .update(
        JSON.stringify({
          clusterId: identity.clusterId,
          instanceId: identity.instanceId,
          repositoryId: identity.repositoryId,
          namespaceUid: namespace.uid,
          namespaceResourceVersion: namespace.resourceVersion,
          podResourceVersion: podList.resourceVersion,
          pods: census.pods.map((pod) => [
            pod.uid,
            pod.runtimeEpoch,
            pod.generation,
            pod.deleting,
            pod.imageIds,
          ]),
          observedAt,
        }),
      )
      .digest("hex");
    const actualImageDigest = pods.length === 1 ? pods[0]?.applicationImageDigest : undefined;
    const isReady = state === "running" && pods.length === 1 && pods[0]?.ready === true;
    return {
      identity: observationIdentity,
      observationId,
      observedAt,
      namespaceExists: true,
      ...(managedIdentity === undefined ? {} : { managedGeneration: managedIdentity.generation }),
      state,
      ...(managedIdentity === undefined ? {} : { repositoryId: managedIdentity.repositoryId }),
      ...(managedIdentity === undefined ? {} : { runtimeEpoch: managedIdentity.runtimeEpoch }),
      ...(releaseId === undefined ? {} : { releaseId }),
      ...(releaseDigest === undefined ? {} : { releaseDigest }),
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(pods.length === 0
        ? {}
        : {
            health: { ready: isReady, checkedAt: new Date(observedAt).toISOString() },
            application: { ready: isReady, observedAt: new Date(observedAt).toISOString() },
          }),
      writerState: this.writerState(pods),
      writerCensus: census,
      ...(actualImageDigest === undefined ? {} : { observedImageDigest: actualImageDigest }),
      conditions: deployment === undefined ? [] : deploymentConditions(deployment),
    };
  }

  async ensureRunning(
    spec: RunningInstanceSpec,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<ApplyResult> {
    this.validateRunningSpec(spec);
    let observation = await this.inspect(spec, signal);
    if (this.isDesiredAndReady(observation, spec)) {
      return {
        status: "unchanged",
        observation,
        progress: [{ phase: "runtime_ready", state: observation.state }],
      };
    }
    if (observation.writerCensus.queriedPodCount > 0) {
      return {
        status: "pending",
        observation,
        progress: [{ phase: "prior_writer_pods_present", state: observation.state }],
      };
    }

    const capacity = await this.getCapacitySnapshot(signal);
    // A second all-Pod census closes the gap between the initial writer check
    // and the live cluster-wide capacity sample.
    observation = await this.inspect(spec, signal);
    if (observation.writerCensus.queriedPodCount > 0) {
      const alreadyReady = this.isDesiredAndReady(observation, spec);
      return {
        status: alreadyReady ? "unchanged" : "pending",
        observation,
        progress: [
          {
            phase: alreadyReady ? "runtime_ready" : "writer_pods_present",
            state: observation.state,
          },
        ],
      };
    }
    const targetReservation = await this.requireTargetReservation(
      spec,
      capacity.capacityEpoch,
      capacity.reservationObservedAt,
    );
    this.assertCapacityForProfile(capacity, spec.resourceProfile, targetReservation.resources);
    await this.deactivateCurrentEndpoint(spec, signal, beforeEffect);
    await this.ensureNamespace(spec, signal, beforeEffect);
    await this.ensureRuntimeRoleBinding(spec, signal, beforeEffect);
    const resources = this.options.renderer.renderRunning(spec);
    this.validateRenderedResources(resources, spec);
    for (const resource of resources)
      await this.upsertResource(resource, spec, signal, beforeEffect);

    observation = await this.inspect(spec, signal);
    const ready = this.isDesiredAndReady(observation, spec);
    return {
      status: ready ? "applied" : "pending",
      observation,
      progress: [
        { phase: ready ? "runtime_ready" : "runtime_converging", state: observation.state },
      ],
    };
  }

  async ensureStopped(
    spec: StoppedInstanceSpec,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<ApplyResult> {
    validateIdentity(spec, this.options.clusterId);
    await this.deactivateCurrentEndpoint(spec, signal, beforeEffect);
    const before = await this.inspect(spec, signal);
    const namespaceName = this.namespaceFor(spec.instanceId);
    const deploymentName = runtimeResourceName(spec.instanceId);
    const deployment = await this.getOptional(
      { kind: "Deployment", namespace: namespaceName, name: deploymentName },
      signal,
    );
    if (deployment === undefined) {
      const complete = before.writerCensus.queriedPodCount === 0;
      return {
        status: complete ? "applied" : "pending",
        observation: before,
        progress: [
          { phase: complete ? "runtime_absent" : "orphan_writer_pods", state: before.state },
        ],
      };
    }

    const metadata = assertObjectOwned(deployment, spec, namespaceName, deploymentName);
    this.assertExactEpoch(metadata, spec);
    const deploymentSpec = record(record(deployment)?.spec);
    if (deploymentSpec?.replicas !== 0) {
      const scaledDown = this.resourceWithReplicas(deployment, 0);
      await beforeEffect();
      await this.options.api
        .applyConditional(
          scaledDown,
          KUBERNETES_FIELD_MANAGER,
          preconditions(metadata).resourceVersion,
          signal,
        )
        .catch((error: unknown) => {
          throw mapKubernetesError(error);
        });
    }
    const after = await this.inspect(spec, signal);
    const stopped = after.writerCensus.queriedPodCount === 0 && after.state === "stopped";
    return {
      status: stopped ? "applied" : "pending",
      observation: after,
      progress: [
        { phase: stopped ? "writer_pods_absent" : "waiting_for_writer_pods", state: after.state },
      ],
    };
  }

  async ensureRelease(
    spec: ReleaseSpec,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<ApplyResult> {
    return this.ensureRunning(spec, signal, beforeEffect);
  }

  async ensureRuntimeDeleted(
    spec: RuntimeDeletionSpec,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<ApplyResult> {
    validateIdentity(spec, this.options.clusterId);
    await this.deactivateCurrentEndpoint(spec, signal, beforeEffect);
    const namespaceName = this.namespaceFor(spec.instanceId);
    const deploymentName = runtimeResourceName(spec.instanceId);
    const deploymentReference = {
      kind: "Deployment",
      namespace: namespaceName,
      name: deploymentName,
    } as const;
    const deployment = await this.getOptional(deploymentReference, signal);
    if (deployment !== undefined) {
      const metadata = assertObjectOwned(deployment, spec, namespaceName, deploymentName);
      this.assertNotNewer(metadata.labels, spec);
      const deploymentSpec = record(record(deployment)?.spec);
      if (deploymentSpec?.replicas !== 0) {
        await beforeEffect();
        await this.options.api
          .applyConditional(
            this.resourceWithReplicas(deployment, 0),
            KUBERNETES_FIELD_MANAGER,
            preconditions(metadata).resourceVersion,
            signal,
          )
          .catch((error: unknown) => {
            throw mapKubernetesError(error);
          });
      }
    }

    const observation = await this.inspect(spec, signal);
    if (observation.writerCensus.queriedPodCount > 0) {
      return {
        status: "pending",
        observation,
        progress: [{ phase: "waiting_for_writer_pods", state: observation.state }],
      };
    }
    if (deployment !== undefined) {
      const current = await this.getOptional(deploymentReference, signal);
      if (current !== undefined) {
        const metadata = assertObjectOwned(current, spec, namespaceName, deploymentName);
        this.assertNotNewer(metadata.labels, spec);
        await beforeEffect();
        await this.options.api
          .deleteConditional(deploymentReference, preconditions(metadata), signal)
          .catch((error: unknown) => {
            if (!optionalApiNotFound(error)) throw mapKubernetesError(error);
          });
      }
    }
    await this.deleteOwnedRuntimeResources(spec, signal, beforeEffect);
    const after = await this.inspect(spec, signal);
    const remaining = await this.listOwnedRuntimeResources(spec, signal);
    const removed =
      after.writerCensus.queriedPodCount === 0 && after.state === "absent" && remaining === 0;
    return {
      status: removed ? "applied" : "pending",
      observation: after,
      progress: [
        { phase: removed ? "runtime_removed" : "runtime_deletion_pending", state: after.state },
      ],
    };
  }

  /** The lifecycle service calls this only after current runtime and auth probes succeed. */
  async activateEndpoint(
    spec: RunningInstanceSpec | ReleaseSpec,
    evidence: RuntimeEndpointActivationEvidence,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<RuntimeObservation> {
    this.validateRunningSpec(spec);
    this.validateActivationEvidence(spec, evidence);
    const observation = await this.inspect(spec, signal);
    const expectedDigest = spec.release.platformManifestDigest;
    if (
      observation.state !== "running" ||
      observation.writerState !== "running" ||
      observation.writerCensus.queriedPodCount !== 1 ||
      observation.identity.runtimeEpoch !== spec.runtimeEpoch ||
      observation.identity.generation !== spec.generation ||
      observation.observedImageDigest !== expectedDigest ||
      evidence.actualImageDigest !== observation.observedImageDigest
    ) {
      throw new RuntimeProviderError(
        "conflict",
        "runtime evidence does not authorize endpoint activation",
        "retryable",
      );
    }
    const endpoint = this.options.renderer.renderEndpoint(spec);
    this.validateEndpointResource(endpoint, spec);
    if (!this.endpointResourceMatchesSpec(endpoint, spec)) {
      throw new RuntimeProviderError(
        "invalid_spec",
        "renderer returned an endpoint with an unexpected host, service, or port",
        "terminal",
      );
    }
    await this.upsertResource(endpoint, spec, signal, beforeEffect);
    try {
      // Probes can expire, and the target can drift while the route write is in
      // flight. Revalidate both the evidence and the live workload afterwards.
      const activated = await this.inspect(spec, signal);
      const route = await this.getOptional(
        {
          kind: "IngressRoute",
          namespace: this.namespaceFor(spec.instanceId),
          name: runtimeResourceName(spec.instanceId),
        },
        signal,
      );
      this.validateActivationEvidence(spec, evidence);
      const expectedEndpoint = `https://${spec.hostname}`;
      if (
        !this.isDesiredAndReady(activated, spec) ||
        !sameIdentity(activated.identity, spec) ||
        activated.application?.ready !== true ||
        activated.health?.ready !== true ||
        activated.observedImageDigest !== spec.release.platformManifestDigest ||
        activated.endpoint !== expectedEndpoint ||
        route === undefined ||
        !this.endpointResourceMatchesSpec(route, spec)
      ) {
        throw new RuntimeProviderError(
          "conflict",
          "runtime or endpoint drifted during endpoint activation",
          "retryable",
        );
      }
      return activated;
    } catch (error) {
      // A route that failed post-write verification must not stay active.
      await this.deactivateCurrentEndpoint(spec, signal, beforeEffect);
      throw error;
    }
  }

  async deactivateEndpoint(
    identity: InstanceIdentity,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<RuntimeObservation> {
    validateIdentity(identity, this.options.clusterId);
    await this.deactivateCurrentEndpoint(identity, signal, beforeEffect);
    return this.inspect(identity, signal);
  }

  /** Returns the owned in-cluster Service address for pre-route signed probes. */
  async getControlEndpoint(spec: RunningInstanceSpec, signal?: AbortSignal): Promise<string> {
    this.validateRunningSpec(spec);
    const httpPort = spec.application?.httpPort;
    if (httpPort === undefined) {
      throw new RuntimeProviderError(
        "invalid_spec",
        "runtime listener port is missing",
        "terminal",
      );
    }
    const observation = await this.inspect(spec, signal);
    if (!this.isDesiredAndReady(observation, spec) || !sameIdentity(observation.identity, spec)) {
      throw new RuntimeProviderError(
        "unavailable",
        "ready runtime evidence is unavailable for the internal control endpoint",
        "retryable",
      );
    }

    const namespaceName = this.namespaceFor(spec.instanceId);
    const serviceName = runtimeResourceName(spec.instanceId);
    const service = await this.getOptional(
      { kind: "Service", namespace: namespaceName, name: serviceName },
      signal,
    );
    if (service === undefined) {
      throw new RuntimeProviderError(
        "unavailable",
        "owned runtime Service is not observed",
        "retryable",
      );
    }
    const metadata = assertObjectOwned(service, spec, namespaceName, serviceName);
    const labels = resourceLabels(spec, spec.release.releaseId);
    const serviceSpec = record(record(service)?.spec);
    const ports = Array.isArray(serviceSpec?.ports) ? serviceSpec.ports : [];
    const port = record(ports[0]);
    const selector = record(serviceSpec?.selector);
    const expectedSelector = {
      [INSTANCE_LABEL_KEY]: spec.instanceId,
      "app.kubernetes.io/name": "scriptorium",
    };
    if (
      !targetMatches(metadata, spec) ||
      Object.entries(labels).some(([key, value]) => metadata.labels[key] !== value) ||
      serviceSpec?.type !== "ClusterIP" ||
      serviceSpec.externalName !== undefined ||
      ports.length !== 1 ||
      port?.name !== "http" ||
      port.port !== httpPort ||
      port.targetPort !== "http" ||
      port.protocol !== "TCP" ||
      selector === undefined ||
      Object.keys(selector).length !== Object.keys(expectedSelector).length ||
      Object.entries(expectedSelector).some(([key, value]) => selector[key] !== value)
    ) {
      throw new RuntimeProviderError(
        "conflict",
        "runtime Service identity or port does not match the ready application",
        "retryable",
      );
    }
    return `http://${serviceName}.${namespaceName}.svc.cluster.local:${httpPort}`;
  }

  async listManagedInstances(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<RuntimePage<ManagedRuntimeSummary>> {
    const page = await this.options.api
      .list(
        "Deployment",
        "",
        managedLabelSelector() + "," + CLUSTER_LABEL_KEY + "=" + this.options.clusterId,
        cursor,
        signal,
      )
      .catch((error: unknown) => {
        throw mapKubernetesError(error);
      });
    const items: ManagedRuntimeSummary[] = [];
    for (const value of page.items) {
      const metadata = objectMetadata(value);
      const identity = identityFromLabels(metadata.labels, this.options.clusterId);
      if (identity === null) {
        throw new RuntimeProviderError(
          "invalid_response",
          "managed Deployment identity is invalid",
          "retryable",
        );
      }
      if (metadata.namespace !== this.namespaceFor(identity.instanceId)) {
        throw new RuntimeProviderError(
          "conflict",
          "managed Deployment is outside its instance namespace",
          "terminal",
        );
      }
      const observation = await this.inspect(identity, signal);
      if (observation.managedGeneration === undefined) continue;
      items.push({
        ...observation.identity,
        managedGeneration: observation.managedGeneration,
        state: observation.state,
        ...(observation.releaseId === undefined ? {} : { releaseId: observation.releaseId }),
        ...(observation.releaseDigest === undefined
          ? {}
          : { releaseDigest: observation.releaseDigest }),
        ...(observation.endpoint === undefined ? {} : { endpoint: observation.endpoint }),
      });
    }
    return { items, nextCursor: page.nextCursor };
  }

  async getCapacitySnapshot(signal?: AbortSignal) {
    return import("./capacity.js").then(({ readKubernetesCapacity }) =>
      readKubernetesCapacity(
        {
          clusterId: this.options.clusterId,
          api: this.options.api,
          reservations: this.options.reservations,
          now: this.now,
          maxAgeMs: this.options.maxCapacityAgeMs,
        },
        signal,
      ),
    );
  }

  private namespaceFor(instanceId: InstanceIdentity["instanceId"]): string {
    return runtimeNamespaceName(this.namespacePrefix, instanceId);
  }

  private async getNamespaceOptional(
    namespaceName: string,
    signal?: AbortSignal,
  ): Promise<unknown | undefined> {
    try {
      return await this.options.api.getNamespace(namespaceName, signal);
    } catch (error) {
      if (optionalApiNotFound(error)) return undefined;
      throw mapKubernetesError(error);
    }
  }

  private async getOptional(
    reference: {
      readonly kind: KubernetesReadableResourceKind;
      readonly namespace: string;
      readonly name: string;
    },
    signal?: AbortSignal,
  ): Promise<unknown | undefined> {
    try {
      return await this.options.api.get(reference, signal);
    } catch (error) {
      if (optionalApiNotFound(error)) return undefined;
      throw mapKubernetesError(error);
    }
  }

  private absentObservation(identity: InstanceIdentity, namespaceName: string): RuntimeObservation {
    const observedAt = this.now();
    const writerCensus: RuntimeWriterCensus = {
      scope: "instance-repository-all-epochs",
      complete: true,
      queriedNamespace: namespaceName,
      namespaceUid: null,
      namespaceResourceVersion: null,
      listResourceVersion: null,
      queriedPodCount: 0,
      pods: [],
    };
    const observationId = createHash("sha256")
      .update(
        JSON.stringify({
          clusterId: identity.clusterId,
          instanceId: identity.instanceId,
          repositoryId: identity.repositoryId,
          namespaceAbsent: true,
          observedAt,
        }),
      )
      .digest("hex");
    return {
      identity,
      observationId,
      observedAt,
      namespaceExists: false,
      state: "absent",
      writerState: "absent",
      writerCensus,
      conditions: [],
    };
  }

  private writerState(
    pods: readonly ParsedPodEvidence[],
  ): "absent" | "running" | "terminating" | "unknown" {
    if (pods.length === 0) return "absent";
    if (pods.some((pod) => !pod.ownershipValid)) return "unknown";
    return pods.every((pod) => pod.deleting) ? "terminating" : "running";
  }

  private observedState(
    deployment: unknown | undefined,
    pods: readonly ParsedPodEvidence[],
    deploymentMetadata: ObjectMetadata | undefined,
  ): RuntimeNeutralState {
    if (deployment === undefined) return pods.length === 0 ? "absent" : "unknown";
    if (deploymentMetadata?.deleting) return "deleting";
    const spec = record(record(deployment)?.spec);
    const status = record(record(deployment)?.status);
    const desiredReplicas = numberValue(spec?.replicas) ?? 1;
    if (desiredReplicas === 0) return pods.length === 0 ? "stopped" : "deleting";
    const failed = deploymentConditions(deployment).some(
      (condition) => condition.type === "ReplicaFailure" && condition.status === "true",
    );
    if (failed || pods.some((pod) => pod.phase === "Failed")) return "failed";
    if (pods.length === 1 && pods[0]?.ready === true && numberValue(status?.readyReplicas) === 1)
      return "running";
    return "provisioning";
  }

  private observedEndpointHost(route: unknown, identity: InstanceIdentity): string | undefined {
    const metadata = objectMetadata(route);
    if (!targetMatches(metadata, identity)) return undefined;
    const routes = record(record(route)?.spec)?.routes;
    if (!Array.isArray(routes)) return undefined;
    const targetName = runtimeResourceName(identity.instanceId);
    const matchingHosts: string[] = [];
    for (const value of routes) {
      const routeEntry = record(value);
      if (routeEntry === undefined) continue;
      const match = routeEntry?.match;
      if (typeof match !== "string" || !match.startsWith("Host(") || !match.endsWith(")")) continue;
      const host = match.slice(6, -2);
      if (host.length === 0 || host.includes(String.fromCharCode(96))) continue;
      const services = Array.isArray(routeEntry.services) ? routeEntry.services : [];
      if (services.length !== 1) continue;
      const service = record(services[0]);
      if (service?.name === targetName && typeof service.port === "number")
        matchingHosts.push(host);
    }
    return matchingHosts.length === 1 ? matchingHosts[0] : undefined;
  }

  private endpointResourceMatchesSpec(
    route: unknown,
    spec: RunningInstanceSpec | ReleaseSpec,
  ): boolean {
    const metadata = objectMetadata(route);
    const resource = record(route);
    const routeSpec = record(resource?.spec);
    const routes = Array.isArray(routeSpec?.routes) ? routeSpec.routes : [];
    const expectedLabels = resourceLabels(spec, spec.release.releaseId);
    const entryPoints = Array.isArray(routeSpec?.entryPoints) ? routeSpec.entryPoints : [];
    const tls = record(routeSpec?.tls);
    if (
      resource?.apiVersion !== "traefik.io/v1alpha1" ||
      resource.kind !== "IngressRoute" ||
      metadata.namespace !== this.namespaceFor(spec.instanceId) ||
      metadata.name !== runtimeResourceName(spec.instanceId) ||
      !targetMatches(metadata, spec) ||
      Object.entries(expectedLabels).some(([key, value]) => metadata.labels[key] !== value) ||
      entryPoints.length !== 1 ||
      entryPoints[0] !== "websecure" ||
      tls === undefined ||
      Object.keys(tls).length !== 0 ||
      routes.length !== 1
    ) {
      return false;
    }
    const entry = record(routes[0]);
    const services = Array.isArray(entry?.services) ? entry.services : [];
    const service = record(services[0]);
    return (
      entry?.kind === "Rule" &&
      entry?.match === `Host(\`${spec.hostname}\`)` &&
      entry.priority === 10 &&
      services.length === 1 &&
      service?.name === runtimeResourceName(spec.instanceId) &&
      Object.keys(service).length === 2 &&
      service.namespace === undefined &&
      service.port === spec.application?.httpPort
    );
  }

  private validateRunningSpec(spec: RunningInstanceSpec | ReleaseSpec): void {
    validateIdentity(spec, this.options.clusterId);
    validateRelease(spec);
    validateProfile(spec.resourceProfile);
    if (spec.application === undefined || spec.hostname === null) {
      throw new RuntimeProviderError(
        "invalid_spec",
        "producer application metadata and stable hostname are required",
        "terminal",
      );
    }
  }

  private isDesiredAndReady(
    observation: RuntimeObservation,
    spec: RunningInstanceSpec | ReleaseSpec,
  ): boolean {
    return (
      observation.state === "running" &&
      observation.writerState === "running" &&
      observation.writerCensus.queriedPodCount === 1 &&
      sameIdentity(observation.identity, spec) &&
      observation.application?.ready === true &&
      observation.health?.ready === true &&
      observation.releaseId === spec.release.releaseId &&
      observation.releaseDigest === spec.release.imageDigest &&
      observation.observedImageDigest === spec.release.platformManifestDigest
    );
  }

  private assertCapacityForProfile(
    capacity: Awaited<ReturnType<KubernetesRuntimeProvider["getCapacitySnapshot"]>>,
    profile: RuntimeResourceProfile,
    targetReservation: RuntimeResourceQuantities,
  ): void {
    validateProfile(profile);
    const now = this.now();
    if (
      capacity.authoritative !== true ||
      !Number.isSafeInteger(capacity.observedAt) ||
      capacity.observedAt > now ||
      now - capacity.observedAt > this.options.maxCapacityAgeMs
    ) {
      throw new RuntimeProviderError(
        "capacity",
        "fresh authoritative Kubernetes capacity is unavailable",
        "retryable",
      );
    }
    const otherReservations = minusFloor(capacity.reserved, targetReservation);
    const aggregateAvailable = {
      cpuMilli: capacity.cpuMilli + targetReservation.cpuMilli,
      memoryMiB: capacity.memoryMiB + targetReservation.memoryMiB,
      ephemeralStorageMiB: capacity.ephemeralStorageMiB + targetReservation.ephemeralStorageMiB,
    };
    // Without node affinity in the reservation contract, account every pending
    // reservation against every candidate node to avoid hiding fragmentation.
    const placeableNode = capacity.nodes.some((node) =>
      resourceRequestFits(profile.request, minusFloor(node.available, otherReservations)),
    );
    if (!resourceRequestFits(profile.request, aggregateAvailable) || !placeableNode) {
      throw new RuntimeProviderError(
        "capacity",
        "runtime resource profile does not fit authoritative free capacity",
        "retryable",
      );
    }
  }

  private async requireTargetReservation(
    spec: RunningInstanceSpec,
    expectedCapacityEpoch: number,
    expectedObservedAt: number,
  ): Promise<KubernetesCapacityReservation> {
    const snapshot = await this.options.reservations
      .currentReservations(this.options.clusterId)
      .catch(() => {
        throw new RuntimeProviderError(
          "capacity",
          "target runtime reservation is unavailable",
          "retryable",
        );
      });
    if (
      snapshot.clusterId !== this.options.clusterId ||
      snapshot.complete !== true ||
      snapshot.capacity === null ||
      snapshot.capacityEpoch !== expectedCapacityEpoch ||
      snapshot.observedAt !== expectedObservedAt
    ) {
      throw new RuntimeProviderError(
        "capacity",
        "target reservation is not bound to the current capacity snapshot",
        "retryable",
      );
    }
    const matches = snapshot.reservations.filter(
      (reservation) =>
        reservation.clusterId === spec.clusterId &&
        reservation.instanceId === spec.instanceId &&
        reservation.repositoryId === spec.repositoryId &&
        reservation.runtimeEpoch === spec.runtimeEpoch &&
        reservation.generation === spec.generation &&
        (reservation.status === "reserved" || reservation.status === "allocated"),
    );
    if (matches.length !== 1) {
      throw new RuntimeProviderError(
        "capacity",
        "one exact target runtime reservation is required",
        "retryable",
      );
    }
    const reservation = matches[0]!;
    if (
      reservation.status !== "reserved" ||
      reservation.resources.cpuMilli !== spec.resourceProfile.request.cpuMilli ||
      reservation.resources.memoryMiB !== spec.resourceProfile.request.memoryMiB ||
      reservation.resources.ephemeralStorageMiB !== spec.resourceProfile.request.ephemeralStorageMiB
    ) {
      throw new RuntimeProviderError(
        "capacity",
        "target reservation does not match the requested runtime profile",
        "retryable",
      );
    }
    return reservation;
  }

  private validateActivationEvidence(
    spec: RunningInstanceSpec | ReleaseSpec,
    evidence: RuntimeEndpointActivationEvidence,
  ): void {
    const now = this.now();
    const same =
      evidence.identity.instanceId === spec.instanceId &&
      evidence.identity.repositoryId === spec.repositoryId &&
      evidence.identity.runtimeEpoch === spec.runtimeEpoch &&
      evidence.identity.generation === spec.generation &&
      evidence.identity.clusterId === spec.clusterId;
    if (!same || evidence.actualImageDigest !== spec.release.platformManifestDigest) {
      throw new RuntimeProviderError(
        "conflict",
        "endpoint activation evidence does not match the desired runtime",
        "retryable",
      );
    }
    for (const probe of [evidence.applicationProbe, evidence.authProbe]) {
      if (typeof probe.id !== "string" || probe.id.length === 0 || probe.id.length > 256) {
        throw new RuntimeProviderError(
          "invalid_spec",
          "endpoint probe evidence id is invalid",
          "terminal",
        );
      }
      if (
        probe.ready !== true ||
        !Number.isSafeInteger(probe.observedAt) ||
        probe.observedAt > now ||
        now - probe.observedAt > this.maxActivationEvidenceAgeMs
      ) {
        throw new RuntimeProviderError(
          "conflict",
          "endpoint probe evidence is stale or not ready",
          "retryable",
        );
      }
    }
  }

  private validateRenderedResources(
    resources: readonly KubernetesResource[],
    spec: RunningInstanceSpec | ReleaseSpec,
  ): void {
    if (resources.length === 0)
      throw new RuntimeProviderError(
        "invalid_spec",
        "runtime renderer returned no resources",
        "terminal",
      );
    const baseName = runtimeResourceName(spec.instanceId);
    const expectedNames = new Set([
      baseName,
      baseName + "-app",
      baseName + "-network",
      baseName + "-quota",
      baseName + "-limits",
    ]);
    const namespaceName = this.namespaceFor(spec.instanceId);
    for (const resource of resources) {
      if (
        !(KUBERNETES_RESOURCE_KINDS as readonly string[]).includes(resource.kind) ||
        resource.kind === "IngressRoute" ||
        resource.metadata.namespace !== namespaceName ||
        !expectedNames.has(resource.metadata.name) ||
        resource.apiVersion !== API_VERSIONS[resource.kind]
      ) {
        throw new RuntimeProviderError(
          "invalid_spec",
          "renderer returned a resource outside the runtime allowlist",
          "terminal",
        );
      }
      const expected = resourceLabels(spec, spec.release.releaseId);
      if (
        Object.entries(expected).some(([key, value]) => resource.metadata.labels[key] !== value)
      ) {
        throw new RuntimeProviderError(
          "invalid_spec",
          "renderer returned mismatched ownership labels",
          "terminal",
        );
      }
    }
    const deployment = resources.find((resource) => resource.kind === "Deployment");
    if (deployment === undefined || appContainerImage(deployment) !== spec.release.artifactRef) {
      throw new RuntimeProviderError(
        "invalid_spec",
        "renderer did not use the admitted immutable artifact",
        "terminal",
      );
    }
  }

  private validateEndpointResource(
    resource: KubernetesResource,
    spec: RunningInstanceSpec | ReleaseSpec,
  ): void {
    const expectedName = runtimeResourceName(spec.instanceId);
    if (
      resource.kind !== "IngressRoute" ||
      resource.apiVersion !== "traefik.io/v1alpha1" ||
      resource.metadata.name !== expectedName ||
      resource.metadata.namespace !== this.namespaceFor(spec.instanceId) ||
      Object.entries(resourceLabels(spec, spec.release.releaseId)).some(
        ([key, value]) => resource.metadata.labels[key] !== value,
      )
    ) {
      throw new RuntimeProviderError(
        "invalid_spec",
        "renderer returned an invalid endpoint resource",
        "terminal",
      );
    }
  }

  private async ensureNamespace(
    identity: InstanceIdentity,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<void> {
    const namespaceName = this.namespaceFor(identity.instanceId);
    const existing = await this.getNamespaceOptional(namespaceName, signal);
    if (existing !== undefined) {
      assertNamespaceOwned(existing, identity, namespaceName);
      return;
    }
    const namespace: KubernetesNamespace = {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: namespaceName, labels: namespaceLabels(identity) },
    };
    await beforeEffect();
    try {
      await this.options.api.createNamespace(namespace, signal);
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 409) {
        const raced = await this.getNamespaceOptional(namespaceName, signal);
        if (raced !== undefined) {
          assertNamespaceOwned(raced, identity, namespaceName);
          return;
        }
      }
      throw mapKubernetesError(error);
    }
  }

  private async ensureRuntimeRoleBinding(
    identity: InstanceIdentity,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<void> {
    const namespaceName = this.namespaceFor(identity.instanceId);
    const name = "praetorium-provisioner-runtime";
    const reference = { kind: "RoleBinding", namespace: namespaceName, name } as const;
    const existing = await this.getOptional(reference, signal);
    const binding: KubernetesResource = {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name, namespace: namespaceName, labels: resourceLabels(identity, null) },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: PROVISIONER_TENANT_ROLE,
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: PROVISIONER_SERVICE_ACCOUNT,
          namespace: PROVISIONER_NAMESPACE,
        },
      ],
    };
    if (existing !== undefined) {
      const metadata = this.assertFixedRuntimeRoleBinding(existing, identity, namespaceName, name);
      const expectedLabels = resourceLabels(identity, null);
      if (Object.entries(expectedLabels).some(([key, value]) => metadata.labels[key] !== value)) {
        await beforeEffect();
        await this.options.api
          .applyConditional(
            binding,
            KUBERNETES_FIELD_MANAGER,
            preconditions(metadata).resourceVersion,
            signal,
          )
          .catch((error: unknown) => {
            throw mapKubernetesError(error);
          });
      }
      return;
    }
    await beforeEffect();
    try {
      await this.options.api.create(binding, signal);
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 409) {
        const raced = await this.getOptional(reference, signal);
        if (raced !== undefined)
          this.assertFixedRuntimeRoleBinding(raced, identity, namespaceName, name);
        else throw mapKubernetesError(error);
      } else {
        throw mapKubernetesError(error);
      }
    }
  }

  private assertFixedRuntimeRoleBinding(
    value: unknown,
    identity: InstanceIdentity,
    namespaceName: string,
    name: string,
  ): ObjectMetadata {
    const metadata = assertObjectOwned(value, identity, namespaceName, name);
    this.assertNotNewer(metadata.labels, identity);
    const roleRef = record(record(value)?.roleRef);
    const subjects = Array.isArray(record(value)?.subjects)
      ? (record(value)?.subjects as unknown[])
      : [];
    const subject = record(subjects[0]);
    if (
      roleRef?.apiGroup !== "rbac.authorization.k8s.io" ||
      roleRef.kind !== "ClusterRole" ||
      roleRef.name !== PROVISIONER_TENANT_ROLE ||
      subjects.length !== 1 ||
      subject?.kind !== "ServiceAccount" ||
      subject.name !== PROVISIONER_SERVICE_ACCOUNT ||
      subject.namespace !== PROVISIONER_NAMESPACE
    ) {
      throw new RuntimeProviderError(
        "conflict",
        "tenant runtime RoleBinding is not the fixed provisioner grant",
        "terminal",
      );
    }
    return metadata;
  }

  private async upsertResource(
    resource: KubernetesResource,
    identity: InstanceIdentity,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<void> {
    const reference = {
      kind: resource.kind,
      namespace: resource.metadata.namespace,
      name: resource.metadata.name,
    } as const;
    const current = await this.getOptional(reference, signal);
    if (current === undefined) {
      await beforeEffect();
      try {
        await this.options.api.create(resource, signal);
        return;
      } catch (error) {
        if (error instanceof KubernetesApiError && error.statusCode === 409) {
          const raced = await this.getOptional(reference, signal);
          if (raced !== undefined) {
            await this.applyOwnedResource(resource, raced, identity, signal, beforeEffect);
            return;
          }
        }
        throw mapKubernetesError(error);
      }
    }
    await this.applyOwnedResource(resource, current, identity, signal, beforeEffect);
  }

  private async applyOwnedResource(
    resource: KubernetesResource,
    current: unknown,
    identity: InstanceIdentity,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<void> {
    const metadata = assertObjectOwned(
      current,
      identity,
      resource.metadata.namespace,
      resource.metadata.name,
    );
    this.assertNotNewer(metadata.labels, identity);
    if (metadata.deleting)
      throw new RuntimeProviderError("conflict", "runtime resource is deleting", "retryable");
    await beforeEffect();
    await this.options.api
      .applyConditional(
        resource,
        KUBERNETES_FIELD_MANAGER,
        preconditions(metadata).resourceVersion,
        signal,
      )
      .catch((error: unknown) => {
        throw mapKubernetesError(error);
      });
  }

  private assertNotNewer(
    labels: Readonly<Record<string, string>>,
    identity: InstanceIdentity,
  ): void {
    const ownerIdentity = identityFromLabels(labels, this.options.clusterId);
    if (
      ownerIdentity === null ||
      ownerIdentity.instanceId !== identity.instanceId ||
      ownerIdentity.repositoryId !== identity.repositoryId
    ) {
      throw new RuntimeProviderError(
        "conflict",
        "runtime resource ownership does not match the desired instance",
        "terminal",
      );
    }
    assertNotNewerThan(labels, identity);
  }

  private assertExactEpoch(metadata: ObjectMetadata, identity: InstanceIdentity): void {
    const current = identityFromLabels(metadata.labels, this.options.clusterId);
    if (current === null || current.runtimeEpoch !== identity.runtimeEpoch) {
      throw new RuntimeProviderError(
        "conflict",
        "runtime operation does not own the current epoch",
        "retryable",
      );
    }
    if (current.generation > identity.generation) {
      throw new RuntimeProviderError(
        "conflict",
        "runtime operation has a stale generation",
        "retryable",
      );
    }
  }

  private resourceWithReplicas(value: unknown, replicas: 0): KubernetesResource {
    const metadata = objectMetadata(value);
    if (stringValue(record(value)?.apiVersion) !== "apps/v1") {
      throw new RuntimeProviderError(
        "invalid_response",
        "managed Deployment api version is invalid",
        "retryable",
      );
    }
    const spec = record(record(value)?.spec);
    if (spec === undefined)
      throw new RuntimeProviderError(
        "invalid_response",
        "managed Deployment spec is missing",
        "retryable",
      );
    return {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: metadata.name,
        namespace: metadata.namespace ?? "",
        labels: metadata.labels,
        annotations: metadata.annotations,
      },
      spec: { ...spec, replicas },
    };
  }

  private async deactivateCurrentEndpoint(
    identity: InstanceIdentity,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<void> {
    const namespaceName = this.namespaceFor(identity.instanceId);
    const name = runtimeResourceName(identity.instanceId);
    const reference = { kind: "IngressRoute", namespace: namespaceName, name } as const;
    const route = await this.getOptional(reference, signal);
    if (route === undefined) return;
    const metadata = assertObjectOwned(route, identity, namespaceName, name);
    this.assertNotNewer(metadata.labels, identity);
    await beforeEffect();
    await this.options.api
      .deleteConditional(reference, preconditions(metadata), signal)
      .catch((error: unknown) => {
        if (!optionalApiNotFound(error)) throw mapKubernetesError(error);
      });
  }

  private async deleteOwnedRuntimeResources(
    identity: InstanceIdentity,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<void> {
    const name = runtimeResourceName(identity.instanceId);
    const resources = [
      { kind: "Service" as const, name },
      { kind: "NetworkPolicy" as const, name: `${name}-network` },
      { kind: "ResourceQuota" as const, name: `${name}-quota` },
      { kind: "LimitRange" as const, name: `${name}-limits` },
      { kind: "ServiceAccount" as const, name: `${name}-app` },
      { kind: "RoleBinding" as const, name: "praetorium-provisioner-runtime" },
    ];
    const namespaceName = this.namespaceFor(identity.instanceId);
    for (const resource of resources) {
      const reference = {
        kind: resource.kind,
        namespace: namespaceName,
        name: resource.name,
      } as const;
      const value = await this.getOptional(reference, signal);
      if (value === undefined) continue;
      const metadata = assertObjectOwned(value, identity, namespaceName, resource.name);
      this.assertNotNewer(metadata.labels, identity);
      await beforeEffect();
      await this.options.api
        .deleteConditional(reference, preconditions(metadata), signal)
        .catch((error: unknown) => {
          if (!optionalApiNotFound(error)) throw mapKubernetesError(error);
        });
    }
  }

  private async listOwnedRuntimeResources(
    identity: InstanceIdentity,
    signal: AbortSignal,
  ): Promise<number> {
    const name = runtimeResourceName(identity.instanceId);
    const references = [
      { kind: "Service" as const, name },
      { kind: "NetworkPolicy" as const, name: `${name}-network` },
      { kind: "ResourceQuota" as const, name: `${name}-quota` },
      { kind: "LimitRange" as const, name: `${name}-limits` },
      { kind: "ServiceAccount" as const, name: `${name}-app` },
      { kind: "RoleBinding" as const, name: "praetorium-provisioner-runtime" },
      { kind: "Deployment" as const, name },
      { kind: "IngressRoute" as const, name },
    ];
    let count = 0;
    const namespaceName = this.namespaceFor(identity.instanceId);
    for (const resource of references) {
      if ((await this.getOptional({ ...resource, namespace: namespaceName }, signal)) !== undefined)
        count += 1;
    }
    return count;
  }
}

export function createInClusterKubernetesRuntimeProvider(
  options: InClusterKubernetesRuntimeProviderOptions,
): KubernetesRuntimeProvider {
  const renderer = createKubernetesResourceRenderer({
    ...options.rendererOptions,
    namespacePrefix: options.namespacePrefix,
    clusterId: options.clusterId,
  });
  return new KubernetesRuntimeProvider({
    ...options,
    api: createInClusterKubernetesApi(),
    renderer,
  });
}
