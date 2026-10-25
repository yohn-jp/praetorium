import { RuntimeAssignmentSchema, type RuntimeAssignment } from "@praetorium/contracts";
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
import {
  createEmptyHistorySnapshot,
  HISTORY_CONTRACT_VERSION,
  HISTORY_RESTORE_NODE_SCRIPT,
  HISTORY_SEED_KEY,
  HISTORY_STORAGE_MIB,
  parseHistorySnapshot,
  type HistorySnapshot,
  type HistorySourceDirectory,
} from "./history.js";
import type {
  ApplyResult,
  InstanceIdentity,
  ManagedRuntimeSummary,
  ReleaseSpec,
  RuntimeCondition,
  RuntimeDeletionSpec,
  RuntimeEffectGuard,
  RuntimeEndpointActivationEvidence,
  RuntimeIdentityProjection,
  RuntimeNeutralState,
  RuntimeObservation,
  RuntimePage,
  RuntimeProvider,
  RuntimeResourceProfile,
  RuntimeResourceQuantities,
  RuntimeInstanceSpec,
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
import { validateApplicationImagePullConfig } from "./image-pull-config.js";
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
  PersistentVolumeClaim: "v1",
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
const HISTORY_ANNOTATION = "praetorium.io/history-contract";
const LEGACY_HISTORY_CURSOR_PATH = "recent-activity/recent-activity-state.json";
const HISTORY_STORAGE_CLASS = "local-path";

export interface KubernetesRuntimeProviderOptions {
  readonly api: KubernetesApi;
  readonly namespacePrefix: string;
  readonly clusterId: string;
  readonly renderer: KubernetesResourceRenderer;
  readonly reservations: KubernetesCapacityReservationSource;
  readonly now?: () => number;
  readonly maxCapacityAgeMs: number;
  readonly maxActivationEvidenceAgeMs?: number;
  /** Operator-owned Docker config; never part of a RuntimeInstanceSpec. */
  readonly imagePullConfigJson?: string;
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

type HistoryPodLayout =
  | { readonly kind: "legacy"; readonly sourceDirectory: HistorySourceDirectory }
  | { readonly kind: "persistent" };

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

function historyLabels(identity: InstanceIdentity): Readonly<Record<string, string>> {
  return {
    ...namespaceOwnershipLabels(identity),
    "app.kubernetes.io/name": "scriptorium",
  };
}

function historyClaimName(identity: InstanceIdentity): string {
  return `${runtimeResourceName(identity.instanceId)}-history`;
}

function historySeedName(identity: InstanceIdentity): string {
  return `${runtimeResourceName(identity.instanceId)}-history-seed`;
}

function stableHistoryResourceMetadata(
  value: unknown,
  identity: InstanceIdentity,
  namespaceName: string,
  expectedName: string,
): ObjectMetadata {
  const metadata = objectMetadata(value);
  const expected = historyLabels(identity);
  if (
    metadata.namespace !== namespaceName ||
    metadata.name !== expectedName ||
    metadata.uid === null ||
    metadata.deleting ||
    Object.entries(expected).some(([key, label]) => metadata.labels[key] !== label) ||
    [RUNTIME_EPOCH_LABEL_KEY, GENERATION_LABEL_KEY, RELEASE_LABEL_KEY].some(
      (key) => key in metadata.labels,
    ) ||
    metadata.annotations[HISTORY_ANNOTATION] !== HISTORY_CONTRACT_VERSION
  ) {
    throw new RuntimeProviderError(
      "conflict",
      "stable private-history resource ownership does not match",
      "terminal",
    );
  }
  return metadata;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function decodeBase64Text(value: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))
    throw new TypeError("private-history Secret encoding is invalid");
  const binary = atob(value);
  if (btoa(binary) !== value) throw new TypeError("private-history Secret encoding is not canonical");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

const RESTRICTED_POD_SECURITY_LABELS = {
  "pod-security.kubernetes.io/enforce": "restricted",
  "pod-security.kubernetes.io/audit": "restricted",
  "pod-security.kubernetes.io/warn": "restricted",
} as const;
const APPLICATION_LABEL_VALUE = "scriptorium";
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
  const ready = status?.phase === "Running" && conditions.some((condition) => {
    const item = record(condition);
    return item?.type === "Ready" && item.status === "True";
  });
  const statuses = Array.isArray(status?.containerStatuses) ? status.containerStatuses : [];
  const imageIds = statuses.flatMap((item): string[] => {
    const imageId = stringValue(record(item)?.imageID);
    return imageId === null ? [] : [imageId];
  });
  const applicationStatus = record(statuses.find((item) => record(item)?.name === "scriptorium"));
  let applicationImageDigest = digestFromImageId(applicationStatus?.imageID);
  // Before the application starts, its imageID is absent. The history init
  // container uses the exact same immutable image on the same node, so its
  // observed platform digest can fence startup authority recovery. This is
  // image evidence only: it never makes an uninitialized Pod ready.
  if (applicationImageDigest === undefined && ownershipValid &&
      podIdentity?.runtimeEpoch === identity.runtimeEpoch && podIdentity.generation === identity.generation &&
      status?.phase === "Pending" &&
      applicationStatus?.started !== true && !stringValue(applicationStatus?.containerID) &&
      record(applicationStatus?.state)?.running === undefined) {
    const podSpec = record(record(value)?.spec);
    const containers = Array.isArray(podSpec?.containers) ? podSpec.containers.map(record) : [];
    const initializers = Array.isArray(podSpec?.initContainers) ? podSpec.initContainers.map(record) : [];
    const application = containers[0];
    const initializer = initializers[0];
    const initStatuses = Array.isArray(status?.initContainerStatuses) ? status.initContainerStatuses : [];
    const observedInit = record(initStatuses.find((item) => record(item)?.name === "history-restore"));
    const initImageId = stringValue(observedInit?.imageID);
    const initDigest = digestFromImageId(initImageId);
    if (containers.length === 1 && application?.name === "scriptorium" &&
        typeof application.image === "string" && /@sha256:[a-f0-9]{64}$/u.test(application.image) &&
        initializers.length === 1 && initializer?.name === "history-restore" &&
        initializer.image === application.image && stringValue(observedInit?.containerID) &&
        initImageId !== null && initDigest !== undefined) {
      applicationImageDigest = initDigest;
      if (!imageIds.includes(initImageId)) imageIds.push(initImageId);
    }
  }
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

function secretText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function runtimeIdentityExpiry(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/u.test(part))) return null;
  try {
    const payload = parts[1]!.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(payload + "=".repeat((4 - (payload.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const exp = record(claims)?.exp;
    return typeof exp === "number" && Number.isSafeInteger(exp) && exp > 0
      ? new Date(exp * 1000).toISOString()
      : null;
  } catch {
    return null;
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
    if (options.imagePullConfigJson !== undefined) {
      try {
        validateApplicationImagePullConfig(options.imagePullConfigJson);
      } catch {
        throw new RuntimeProviderError(
          "misconfigured",
          "application image pull configuration is invalid",
          "terminal",
        );
      }
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

  /** Captures legacy private history only after the lifecycle's safe quiesce. */
  async preserveHistoryBeforeStop(
    spec: StoppedInstanceSpec,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
    drainLegacyHistory?: (input: {
      readonly podName: string;
      readonly podUid: string;
    }) => Promise<void>,
  ): Promise<void> {
    validateIdentity(spec, this.options.clusterId);
    if (spec.scriptoriumAssignment === undefined) {
      await this.assertNoUnclassifiedWriterBeforeStop(spec, signal);
      return;
    }
    const initial = await this.inspect(spec, signal);
    if (initial.writerCensus.queriedPodCount === 0) return;
    const firstWriter = initial.writerCensus.pods[0];
    if (
      initial.writerCensus.complete !== true ||
      spec.release === null ||
      initial.writerCensus.scope !== "instance-repository-all-epochs" ||
      initial.writerCensus.queriedPodCount !== 1 ||
      initial.writerCensus.pods.length !== 1 ||
      initial.writerCensus.namespaceUid === null ||
      firstWriter === undefined ||
      firstWriter.uid.length === 0 ||
      firstWriter.runtimeEpoch !== spec.runtimeEpoch ||
      firstWriter.generation !== spec.generation ||
      firstWriter.phase !== "Running" ||
      firstWriter.deleting ||
      firstWriter.imageIds.every((imageId) => !imageId.endsWith(spec.release?.platformManifestDigest ?? ""))
    ) {
      throw new RuntimeProviderError(
        "unavailable",
        "private-history snapshot requires one exact running writer",
        "retryable",
      );
    }

    const namespaceName = this.namespaceFor(spec.instanceId);
    const pod = await this.getOptional(
      { kind: "Pod", namespace: namespaceName, name: firstWriter.name },
      signal,
    );
    if (pod === undefined)
      throw new RuntimeProviderError("unavailable", "history source Pod disappeared", "retryable");
    const sourceLayout = this.historyPodLayout(pod, spec, firstWriter.uid);
    const pvcName = historyClaimName(spec);
    const seedName = historySeedName(spec);
    const pvc = await this.getOptional(
      { kind: "PersistentVolumeClaim", namespace: namespaceName, name: pvcName },
      signal,
    );
    const existingSeed = await this.getOptional(
      { kind: "Secret", namespace: namespaceName, name: seedName },
      signal,
    );

    if (sourceLayout.kind === "persistent") {
      if (pvc === undefined || existingSeed === undefined)
        throw new RuntimeProviderError(
          "conflict",
          "current private-history Pod is missing its stable PVC or seed Secret",
          "terminal",
        );
      this.assertHistoryPvc(pvc, spec, namespaceName, pvcName);
      this.readHistorySeed(existingSeed, spec, namespaceName, seedName);
      const readMarker = this.options.api.readHistoryMarker;
      if (readMarker === undefined)
        throw new RuntimeProviderError("misconfigured", "private-history marker reader is unavailable", "terminal");
      let marker: Record<string, unknown>;
      try {
        marker = JSON.parse(
          await readMarker.call(this.options.api, {
            namespace: namespaceName,
            podName: firstWriter.name,
            sourcePodUid: firstWriter.uid,
            signal,
          }),
        ) as Record<string, unknown>;
      } catch {
        throw new RuntimeProviderError(
          "unavailable",
          "stable private-history ownership marker could not be verified",
          "retryable",
        );
      }
      if (
        marker.schemaVersion !== 1 ||
        marker.instanceId !== spec.instanceId ||
        marker.repositoryId !== String(spec.repositoryId) ||
        marker.clusterId !== spec.clusterId ||
        marker.claimName !== pvcName ||
        typeof marker.sourcePodUid !== "string" ||
        typeof marker.seedManifestSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(marker.seedManifestSha256)
      ) {
        throw new RuntimeProviderError(
          "conflict",
          "stable private-history ownership marker does not match this instance",
          "terminal",
        );
      }
      return;
    }

    if (pvc !== undefined)
      throw new RuntimeProviderError(
        "conflict",
        "legacy history Pod conflicts with an existing stable PVC",
        "terminal",
      );
    if (drainLegacyHistory === undefined)
      throw new RuntimeProviderError(
        "unavailable",
        "a fenced old-epoch empty-job drain is required before legacy history migration",
        "retryable",
      );

    const readSnapshot = this.options.api.readHistorySnapshot;
    if (readSnapshot === undefined)
      throw new RuntimeProviderError("misconfigured", "private-history snapshot reader is unavailable", "terminal");
    await beforeEffect();
    await drainLegacyHistory({ podName: firstWriter.name, podUid: firstWriter.uid });
    await beforeEffect();
    const firstSnapshot = parseHistorySnapshot(
      await readSnapshot.call(this.options.api, {
        namespace: namespaceName,
        podName: firstWriter.name,
        sourceDirectory: sourceLayout.sourceDirectory,
        sourcePodUid: firstWriter.uid,
        signal,
      }),
      firstWriter.uid,
    );
    assertSupportedLegacyHistory(firstSnapshot);
    const secondCensus = await this.inspect(spec, signal);
    const secondWriter = secondCensus.writerCensus.pods[0];
    if (
      secondCensus.writerCensus.complete !== true ||
      secondCensus.writerCensus.scope !== "instance-repository-all-epochs" ||
      secondCensus.writerCensus.queriedPodCount !== 1 ||
      secondCensus.writerCensus.pods.length !== 1 ||
      secondCensus.writerCensus.namespaceUid !== initial.writerCensus.namespaceUid ||
      secondWriter?.uid !== firstWriter.uid ||
      secondWriter.runtimeEpoch !== spec.runtimeEpoch ||
      secondWriter.generation !== spec.generation ||
      secondWriter.phase !== "Running" ||
      secondWriter.deleting
    ) {
      throw new RuntimeProviderError(
        "conflict",
        "private-history source writer changed during the post-quiesce snapshot",
        "retryable",
      );
    }
    const secondPod = await this.getOptional(
      { kind: "Pod", namespace: namespaceName, name: firstWriter.name },
      signal,
    );
    if (secondPod === undefined) throw new RuntimeProviderError("unavailable", "history source Pod disappeared", "retryable");
    const secondLayout = this.historyPodLayout(secondPod, spec, firstWriter.uid);
    if (secondLayout.kind !== "legacy" || secondLayout.sourceDirectory !== sourceLayout.sourceDirectory)
      throw new RuntimeProviderError("conflict", "private-history source mount changed", "retryable");

    await beforeEffect();
    const secondSnapshot = parseHistorySnapshot(
      await readSnapshot.call(this.options.api, {
        namespace: namespaceName,
        podName: firstWriter.name,
        sourceDirectory: sourceLayout.sourceDirectory,
        sourcePodUid: firstWriter.uid,
        signal,
      }),
      firstWriter.uid,
    );
    assertSupportedLegacyHistory(secondSnapshot);
    if (secondSnapshot.manifestSha256 !== firstSnapshot.manifestSha256)
      throw new RuntimeProviderError(
        "conflict",
        "private history changed during the post-quiesce snapshot",
        "retryable",
      );

    const snapshotSecret = this.historySeedResource(spec, namespaceName, secondSnapshot);
    if (existingSeed !== undefined) {
      const stored = this.readHistorySeed(existingSeed, spec, namespaceName, seedName);
      if (stored.manifestSha256 !== secondSnapshot.manifestSha256)
        throw new RuntimeProviderError(
          "conflict",
          "a different retained private-history seed already exists",
          "terminal",
        );
      return;
    }
    await beforeEffect();
    try {
      await this.options.api.create(snapshotSecret, signal);
    } catch (error) {
      if (!(error instanceof KubernetesApiError) || error.statusCode !== 409)
        throw mapKubernetesError(error);
      const raced = await this.getOptional(
        { kind: "Secret", namespace: namespaceName, name: seedName },
        signal,
      );
      if (raced === undefined)
        throw new RuntimeProviderError("conflict", "private-history seed create raced", "retryable");
      const stored = this.readHistorySeed(raced, spec, namespaceName, seedName);
      if (stored.manifestSha256 !== secondSnapshot.manifestSha256)
        throw new RuntimeProviderError(
          "conflict",
          "a different retained private-history seed already exists",
          "terminal",
        );
    }
  }

  /** Reads the current Provisioner-owned Hosted assignment and identity projection. */
  async readRuntimeIdentityProjection(
    identity: InstanceIdentity,
    signal?: AbortSignal,
  ): Promise<RuntimeIdentityProjection | null> {
    validateIdentity(identity, this.options.clusterId);
    const namespaceName = this.namespaceFor(identity.instanceId);
    const secretName = `${runtimeResourceName(identity.instanceId)}-runtime`;
    const value = await this.getOptional(
      { kind: "Secret", namespace: namespaceName, name: secretName },
      signal,
    );
    if (value === undefined) return null;
    const metadata = assertObjectOwned(value, identity, namespaceName, secretName);
    if (!targetMatches(metadata, identity)) {
      throw new RuntimeProviderError(
        "conflict",
        "Hosted runtime projection belongs to another epoch",
        "retryable",
      );
    }
    const object = record(value);
    const data = record(object?.data);
    const stringData = record(object?.stringData);
    const assignmentText =
      typeof stringData?.["runtime-assignment.json"] === "string"
        ? (stringData["runtime-assignment.json"] as string)
        : secretText(data?.["runtime-assignment.json"]);
    const proof =
      typeof stringData?.["runtime-identity.jwt"] === "string"
        ? (stringData["runtime-identity.jwt"] as string)
        : secretText(data?.["runtime-identity.jwt"]);
    if (assignmentText === null || proof === null || proof.length < 16 || proof.length > 4_096)
      throw new RuntimeProviderError(
        "invalid_response",
        "Hosted runtime projection is incomplete",
        "retryable",
      );
    let assignment: RuntimeAssignment;
    try {
      assignment = RuntimeAssignmentSchema.parse(JSON.parse(assignmentText) as unknown);
    } catch {
      throw new RuntimeProviderError(
        "invalid_response",
        "Hosted runtime assignment is invalid",
        "retryable",
      );
    }
    const expiresAt = runtimeIdentityExpiry(proof);
    const deploymentName = runtimeResourceName(identity.instanceId);
    const deployment = await this.getOptional(
      { kind: "Deployment", namespace: namespaceName, name: deploymentName },
      signal,
    );
    if (deployment === undefined)
      throw new RuntimeProviderError(
        "invalid_response",
        "Hosted runtime deployment is missing",
        "retryable",
      );
    const deploymentMetadata = assertObjectOwned(
      deployment,
      identity,
      namespaceName,
      deploymentName,
    );
    if (
      assignment.instanceId !== (identity.physicalInstanceId ?? identity.instanceId) ||
      assignment.repositoryId !== identity.repositoryId ||
      assignment.runtimeEpoch !== identity.runtimeEpoch ||
      assignment.imageDigest !== deploymentMetadata.annotations["arcadia.io/release-digest"] ||
      expiresAt === null
    )
      throw new RuntimeProviderError(
        "invalid_response",
        "Hosted runtime projection binding is invalid",
        "retryable",
      );
    return { identity, assignment, runtimeIdentityProof: proof, expiresAt };
  }

  /** Renews the existing Secret of the exact live writer, including a runtime
   * still cloning before readiness. The Pod is not restarted. */
  async refreshRuntimeIdentity(
    spec: RunningInstanceSpec,
    proof: string,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<void> {
    this.validateRunningSpec(spec);
    const observation = await this.inspect(spec, signal);
    if (!this.isDesiredAndReady(observation, spec)) {
      // Readiness can depend on Git operations that themselves need renewed
      // identity. The recovery Service verifies the full, exact live writer
      // census and actual image before allowing this startup refresh.
      await this.getRecoveryControlEndpoint(spec, signal);
    }
    const expiresAt = runtimeIdentityExpiry(proof);
    if (
      expiresAt === null ||
      Date.parse(expiresAt) <= this.now() ||
      Date.parse(expiresAt) - this.now() > 300_000
    )
      throw new RuntimeProviderError(
        "invalid_spec",
        "Hosted runtime identity proof lifetime is invalid",
        "terminal",
      );
    const rendered = this.options.renderer.renderRunning({ ...spec, runtimeIdentityProof: proof });
    const secret = rendered.find(
      (resource) =>
        resource.kind === "Secret" &&
        resource.metadata.name === `${runtimeResourceName(spec.instanceId)}-runtime`,
    );
    if (!secret)
      throw new RuntimeProviderError(
        "invalid_spec",
        "Hosted runtime assignment is required for identity refresh",
        "terminal",
      );
    const reference = {
      kind: "Secret",
      namespace: secret.metadata.namespace,
      name: secret.metadata.name,
    } as const;
    const current = await this.getOptional(reference, signal);
    if (current === undefined)
      throw new RuntimeProviderError(
        "conflict",
        "Hosted runtime identity projection is missing",
        "retryable",
      );
    const metadata = assertObjectOwned(current, spec, reference.namespace, reference.name);
    if (!targetMatches(metadata, spec))
      throw new RuntimeProviderError(
        "conflict",
        "Hosted runtime identity projection belongs to another epoch",
        "retryable",
      );
    const currentObject = record(current);
    const currentData = record(currentObject?.data);
    const currentStringData = record(currentObject?.stringData);
    const desiredStringData = record(secret.stringData);
    const currentAssignment =
      typeof currentStringData?.["runtime-assignment.json"] === "string"
        ? (currentStringData["runtime-assignment.json"] as string)
        : secretText(currentData?.["runtime-assignment.json"]);
    if (
      currentAssignment === null ||
      desiredStringData?.["runtime-assignment.json"] !== currentAssignment
    )
      throw new RuntimeProviderError(
        "conflict",
        "Hosted runtime assignment changed during identity refresh",
        "retryable",
      );
    await this.applyOwnedResource(secret, current, spec, signal, beforeEffect);
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
    if (spec.scriptoriumAssignment !== undefined)
      await this.prepareHistorySeed(spec, signal, beforeEffect);
    const resources = this.options.renderer.renderRunning(spec);
    this.validateRenderedResources(resources, spec);
    const imagePullSecret = this.imagePullSecretResource(spec);
    if (imagePullSecret !== undefined)
      await this.upsertResource(imagePullSecret, spec, signal, beforeEffect);
    for (const resource of resources) {
      if (resource.kind === "PersistentVolumeClaim")
        await this.ensureHistoryPvc(resource, spec, signal, beforeEffect);
      else await this.upsertResource(resource, spec, signal, beforeEffect);
    }

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
    if (spec.scriptoriumAssignment === undefined)
      await this.assertNoUnclassifiedWriterBeforeStop(spec, signal);
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
          { force: true },
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
            { force: true },
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

  /** Returns an internal recovery Service only for the exact live writer and image. */
  async getRecoveryControlEndpoint(
    spec: RunningInstanceSpec,
    signal?: AbortSignal,
  ): Promise<string> {
    this.validateRunningSpec(spec);
    const observation = await this.inspect(spec, signal);
    const census = observation.writerCensus;
    const writer = census.pods[0];
    const namespaceName = this.namespaceFor(spec.instanceId);
    if (
      census.scope !== "instance-repository-all-epochs" ||
      census.complete !== true ||
      census.queriedNamespace !== namespaceName ||
      census.namespaceUid === null ||
      census.namespaceResourceVersion === null ||
      census.listResourceVersion === null ||
      census.queriedPodCount !== 1 ||
      census.pods.length !== 1 ||
      writer === undefined ||
      writer.namespace !== namespaceName ||
      writer.uid.length === 0 ||
      writer.runtimeEpoch !== spec.runtimeEpoch ||
      writer.generation !== spec.generation ||
      writer.deleting ||
      writer.phase !== "Running" ||
      !sameIdentity(observation.identity, spec) ||
      observation.observedImageDigest !== spec.release.platformManifestDigest ||
      !writer.imageIds.some((imageId) => imageId.endsWith(spec.release.platformManifestDigest))
    ) {
      throw new RuntimeProviderError(
        "unavailable",
        "exact live writer evidence is unavailable for the recovery endpoint",
        "retryable",
      );
    }

    const serviceName = `${runtimeResourceName(spec.instanceId)}-control`;
    const service = await this.getOptional(
      { kind: "Service", namespace: namespaceName, name: serviceName },
      signal,
    );
    if (service === undefined)
      throw new RuntimeProviderError(
        "unavailable",
        "owned recovery Service is not observed",
        "retryable",
      );
    const metadata = assertObjectOwned(service, spec, namespaceName, serviceName);
    const serviceSpec = record(record(service)?.spec);
    const ports = Array.isArray(serviceSpec?.ports) ? serviceSpec.ports : [];
    const port = record(ports[0]);
    const selector = record(serviceSpec?.selector);
    const expectedSelector = {
      [INSTANCE_LABEL_KEY]: spec.instanceId,
      "app.kubernetes.io/name": APPLICATION_LABEL_VALUE,
      [RUNTIME_EPOCH_LABEL_KEY]: String(spec.runtimeEpoch),
      [GENERATION_LABEL_KEY]: String(spec.generation),
    };
    const expectedLabels = resourceLabels(spec, spec.release.releaseId);
    if (
      !targetMatches(metadata, spec) ||
      Object.entries(expectedLabels).some(([key, value]) => metadata.labels[key] !== value) ||
      serviceSpec?.type !== "ClusterIP" ||
      serviceSpec.publishNotReadyAddresses !== true ||
      serviceSpec.externalName !== undefined ||
      ports.length !== 1 ||
      port?.name !== "http" ||
      port.port !== spec.application?.httpPort ||
      port.targetPort !== "http" ||
      port.protocol !== "TCP" ||
      selector === undefined ||
      Object.keys(selector).length !== Object.keys(expectedSelector).length ||
      Object.entries(expectedSelector).some(([key, value]) => selector[key] !== value)
    ) {
      throw new RuntimeProviderError(
        "conflict",
        "recovery Service identity, selector or port does not match the exact writer",
        "retryable",
      );
    }
    return `http://${serviceName}.${namespaceName}.svc.cluster.local:${spec.application?.httpPort}`;
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

  private historyPodLayout(
    pod: unknown,
    spec: StoppedInstanceSpec,
    expectedUid: string,
  ): HistoryPodLayout {
    const namespaceName = this.namespaceFor(spec.instanceId);
    const metadata = assertObjectOwned(pod, spec, namespaceName);
    const identity = identityFromLabels(metadata.labels, this.options.clusterId);
    const podSpec = record(record(pod)?.spec);
    const status = record(record(pod)?.status);
    const containers = Array.isArray(podSpec?.containers) ? podSpec.containers : [];
    const application = containers.find((container) => record(container)?.name === "scriptorium");
    const applicationRecord = record(application);
    const volumes = Array.isArray(podSpec?.volumes) ? podSpec.volumes.map(record) : [];
    const mounts = Array.isArray(applicationRecord?.volumeMounts)
      ? applicationRecord.volumeMounts.map(record)
      : [];
    const environment = Array.isArray(applicationRecord?.env) ? applicationRecord.env.map(record) : [];
    const usageDirectory = environment.find((item) => item?.name === "SCRIPTORIUM_USAGE_DIR")?.value;
    const hasWorkspace = volumes.some(
      (volume) => volume?.name === "workspace" && record(volume.emptyDir) !== undefined,
    );
    const workspaceMount = mounts.find((mount) => mount?.name === "workspace");
    const historyVolume = volumes.find((volume) => volume?.name === "history");
    const historyMount = mounts.find((mount) => mount?.name === "history");
    const expectedImage = spec.release?.artifactRef;
    if (
      metadata.uid !== expectedUid ||
      metadata.deleting ||
      identity === null ||
      identity.runtimeEpoch !== spec.runtimeEpoch ||
      identity.generation !== spec.generation ||
      status?.phase !== "Running" ||
      applicationRecord?.image !== expectedImage ||
      hasWorkspace !== true ||
      workspaceMount?.mountPath !== "/data" ||
      workspaceMount.readOnly === true
    ) {
      throw new RuntimeProviderError(
        "conflict",
        "private-history source Pod identity or workspace mount is invalid",
        "terminal",
      );
    }
    if (historyVolume !== undefined) {
      const claim = record(historyVolume.persistentVolumeClaim);
      const seedVolume = volumes.find((volume) => volume?.name === "history-seed");
      const seed = record(seedVolume?.secret);
      const initContainers = Array.isArray(podSpec?.initContainers)
        ? podSpec.initContainers.map(record)
        : [];
      const restore = initContainers.find((container) => container?.name === "history-restore");
      const restoreMounts = Array.isArray(restore?.volumeMounts)
        ? restore.volumeMounts.map(record)
        : [];
      const restoreCommand = Array.isArray(restore?.command) ? restore.command : [];
      const initStatuses = Array.isArray(status?.initContainerStatuses)
        ? status.initContainerStatuses.map(record)
        : [];
      const restoreStatus = initStatuses.find((item) => item?.name === "history-restore");
      const terminated = record(record(restoreStatus?.state)?.terminated);
      if (
        claim?.claimName !== historyClaimName(spec) ||
        claim.readOnly === true ||
        historyMount?.mountPath !== "/history" ||
        historyMount.readOnly === true ||
        usageDirectory !== "/history/private" ||
        seed?.secretName !== historySeedName(spec) ||
        restore?.image !== expectedImage ||
        restoreCommand.length !== 3 ||
        restoreCommand[0] !== "node" ||
        restoreCommand[1] !== "-e" ||
        restoreCommand[2] !== HISTORY_RESTORE_NODE_SCRIPT ||
        !restoreMounts.some((mount) => mount?.name === "history" && mount.mountPath === "/history") ||
        !restoreMounts.some((mount) => mount?.name === "history-seed" && mount.mountPath === "/history-seed" && mount.readOnly === true) ||
        terminated?.exitCode !== 0
      ) {
        throw new RuntimeProviderError(
          "conflict",
          "private-history PVC mount or restore init identity is invalid",
          "terminal",
        );
      }
      return { kind: "persistent" };
    }
    if (
      historyMount !== undefined ||
      usageDirectory !== "/data/history" ||
      volumes.some((volume) => volume?.persistentVolumeClaim !== undefined)
    ) {
      throw new RuntimeProviderError(
        "conflict",
        "private-history Pod layout is unsupported",
        "terminal",
      );
    }
    return { kind: "legacy", sourceDirectory: "/data/history" };
  }

  /** A stop without Hosted assignment metadata may not retire a live writer.
   * The caller needs that non-secret metadata to classify and preserve private
   * history before any scale-down. A complete empty census remains safe. */
  private async assertNoUnclassifiedWriterBeforeStop(
    spec: StoppedInstanceSpec,
    signal?: AbortSignal,
  ): Promise<void> {
    const observation = await this.inspect(spec, signal);
    if (
      observation.writerCensus.complete !== true ||
      observation.writerCensus.scope !== "instance-repository-all-epochs" ||
      observation.writerCensus.queriedPodCount !== observation.writerCensus.pods.length
    ) {
      throw new RuntimeProviderError(
        "unavailable",
        "stop without Hosted history metadata requires a complete writer census",
        "retryable",
      );
    }
    if (observation.writerCensus.queriedPodCount !== 0) {
      throw new RuntimeProviderError(
        "misconfigured",
        "Hosted assignment metadata is required before stopping a live writer to preserve private history",
        "terminal",
      );
    }
  }

  private historySeedResource(
    identity: InstanceIdentity,
    namespaceName: string,
    snapshot: HistorySnapshot,
  ): KubernetesResource {
    const name = historySeedName(identity);
    const content = new TextEncoder().encode(JSON.stringify(snapshot));
    if (content.byteLength > 768 * 1024)
      throw new RuntimeProviderError("capacity", "private-history seed exceeds its manifest bound", "terminal");
    return {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name,
        namespace: namespaceName,
        labels: historyLabels(identity),
        annotations: { [HISTORY_ANNOTATION]: HISTORY_CONTRACT_VERSION },
      },
      type: "Opaque",
      immutable: true,
      data: { [HISTORY_SEED_KEY]: encodeBase64(content) },
    };
  }

  private readHistorySeed(
    value: unknown,
    identity: InstanceIdentity,
    namespaceName: string,
    expectedName: string,
  ): HistorySnapshot {
    stableHistoryResourceMetadata(value, identity, namespaceName, expectedName);
    const resource = record(value);
    const data = record(resource?.data);
    if (
      resource?.kind !== "Secret" ||
      resource.apiVersion !== "v1" ||
      resource.type !== "Opaque" ||
      resource.immutable !== true ||
      data === undefined ||
      Object.keys(data).length !== 1 ||
      typeof data[HISTORY_SEED_KEY] !== "string" ||
      data[HISTORY_SEED_KEY].length > 1_000_000
    ) {
      throw new RuntimeProviderError(
        "conflict",
        "stable private-history seed Secret has an invalid shape",
        "terminal",
      );
    }
    try {
      const text = decodeBase64Text(data[HISTORY_SEED_KEY] as string);
      const root = record(JSON.parse(text) as unknown);
      if (typeof root?.sourcePodUid !== "string") throw new TypeError("seed source uid missing");
      return parseHistorySnapshot(text, root.sourcePodUid);
    } catch {
      throw new RuntimeProviderError(
        "conflict",
        "stable private-history seed failed validation",
        "terminal",
      );
    }
  }

  private assertHistoryPvc(
    value: unknown,
    identity: InstanceIdentity & Pick<RuntimeInstanceSpec, "resourceProfile">,
    namespaceName: string,
    expectedName: string,
  ): void {
    stableHistoryResourceMetadata(value, identity, namespaceName, expectedName);
    const resource = record(value);
    const spec = record(resource?.spec);
    const accessModes = Array.isArray(spec?.accessModes) ? spec.accessModes : [];
    const resources = record(spec?.resources);
    const requests = record(resources?.requests);
    const request = requests?.storage;
    const match = typeof request === "string" ? /^([1-9]\d*)Mi$/u.exec(request) : null;
    const requestedMiB = match === null ? null : Number(match[1]);
    if (
      resource?.kind !== "PersistentVolumeClaim" ||
      resource.apiVersion !== "v1" ||
      spec?.storageClassName !== HISTORY_STORAGE_CLASS ||
      accessModes.length !== 1 ||
      accessModes[0] !== "ReadWriteOnce" ||
      requestedMiB === null ||
      !Number.isSafeInteger(requestedMiB) ||
      requestedMiB !== HISTORY_STORAGE_MIB
    ) {
      throw new RuntimeProviderError(
        "conflict",
        "stable private-history PVC does not match its fixed storage capacity",
        "terminal",
      );
    }
  }

  private async prepareHistorySeed(
    spec: RunningInstanceSpec,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<void> {
    const namespaceName = this.namespaceFor(spec.instanceId);
    const claimName = historyClaimName(spec);
    const seedName = historySeedName(spec);
    const pvc = await this.getOptional(
      { kind: "PersistentVolumeClaim", namespace: namespaceName, name: claimName },
      signal,
    );
    if (pvc !== undefined) this.assertHistoryPvc(pvc, spec, namespaceName, claimName);
    const seed = await this.getOptional(
      { kind: "Secret", namespace: namespaceName, name: seedName },
      signal,
    );
    if (seed !== undefined) {
      this.readHistorySeed(seed, spec, namespaceName, seedName);
      return;
    }
    if (pvc !== undefined)
      throw new RuntimeProviderError(
        "conflict",
        "stable private-history PVC exists without its retained seed Secret",
        "terminal",
      );
    const oldDeployment = await this.getOptional(
      { kind: "Deployment", namespace: namespaceName, name: runtimeResourceName(spec.instanceId) },
      signal,
    );
    if (oldDeployment !== undefined)
      throw new RuntimeProviderError(
        "unavailable",
        "existing runtime has no preserved private-history seed or PVC",
        "terminal",
      );
    const emptySeed = this.historySeedResource(
      spec,
      namespaceName,
      createEmptyHistorySnapshot(),
    );
    await beforeEffect();
    try {
      await this.options.api.create(emptySeed, signal);
    } catch (error) {
      if (!(error instanceof KubernetesApiError) || error.statusCode !== 409)
        throw mapKubernetesError(error);
      const raced = await this.getOptional(
        { kind: "Secret", namespace: namespaceName, name: seedName },
        signal,
      );
      if (raced === undefined) throw new RuntimeProviderError("conflict", "history seed create raced", "retryable");
      this.readHistorySeed(raced, spec, namespaceName, seedName);
    }
  }

  private async ensureHistoryPvc(
    resource: KubernetesResource,
    spec: RunningInstanceSpec | ReleaseSpec,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<void> {
    const namespaceName = this.namespaceFor(spec.instanceId);
    const name = historyClaimName(spec);
    const current = await this.getOptional(
      { kind: "PersistentVolumeClaim", namespace: namespaceName, name },
      signal,
    );
    if (current !== undefined) {
      this.assertHistoryPvc(current, spec, namespaceName, name);
      return;
    }
    await beforeEffect();
    try {
      await this.options.api.create(resource, signal);
    } catch (error) {
      if (!(error instanceof KubernetesApiError) || error.statusCode !== 409)
        throw mapKubernetesError(error);
      const raced = await this.getOptional(
        { kind: "PersistentVolumeClaim", namespace: namespaceName, name },
        signal,
      );
      if (raced === undefined) throw new RuntimeProviderError("conflict", "history PVC create raced", "retryable");
      this.assertHistoryPvc(raced, spec, namespaceName, name);
    }
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
    const resource = record(route);
    const routeSpec = record(resource?.spec);
    const routes = Array.isArray(routeSpec?.routes) ? routeSpec.routes : [];
    const entryPoints = Array.isArray(routeSpec?.entryPoints) ? routeSpec.entryPoints : [];
    const tls = record(routeSpec?.tls);
    if (
      resource?.apiVersion !== "traefik.io/v1alpha1" ||
      resource.kind !== "IngressRoute" ||
      entryPoints.length !== 1 ||
      entryPoints[0] !== "websecure" ||
      tls === undefined ||
      Object.keys(tls).length !== 0 ||
      routes.length !== 1
    ) {
      return undefined;
    }
    const targetName = runtimeResourceName(identity.instanceId);
    const routeEntry = record(routes[0]);
    const match = routeEntry?.match;
    const services = Array.isArray(routeEntry?.services) ? routeEntry.services : [];
    const service = record(services[0]);
    if (
      routeEntry?.kind !== "Rule" ||
      typeof match !== "string" ||
      !match.startsWith("Host(`") ||
      !match.endsWith("`)") ||
      routeEntry.priority !== 10 ||
      services.length !== 1 ||
      service?.name !== targetName ||
      !Number.isSafeInteger(service.port) ||
      (service.port as number) < 1 ||
      (service.port as number) > 65_535 ||
      Object.keys(service).some((key) => key !== "name" && key !== "port")
    ) {
      return undefined;
    }
    const host = match.slice(6, -2);
    return host.length === 0 || host.includes(String.fromCharCode(96)) ? undefined : host;
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
      baseName + "-control",
      baseName + "-app",
      baseName + "-network",
      baseName + "-quota",
      baseName + "-limits",
      ...(spec.scriptoriumAssignment === undefined ? [] : [baseName + "-history"]),
      ...(spec.scriptoriumAssignment === undefined ? [] : [baseName + "-runtime"]),
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
      if (resource.kind === "PersistentVolumeClaim") {
        const expectedStableLabels = historyLabels(spec);
        const pvcSpec = record(resource.spec);
        const accessModes = Array.isArray(pvcSpec?.accessModes) ? pvcSpec.accessModes : [];
        const requests = record(record(pvcSpec?.resources)?.requests);
        if (
          spec.scriptoriumAssignment === undefined ||
          resource.metadata.name !== `${baseName}-history` ||
          Object.entries(expectedStableLabels).some(
            ([key, value]) => resource.metadata.labels[key] !== value,
          ) ||
          [RUNTIME_EPOCH_LABEL_KEY, GENERATION_LABEL_KEY, RELEASE_LABEL_KEY].some(
            (key) => key in resource.metadata.labels,
          ) ||
          resource.metadata.annotations?.[HISTORY_ANNOTATION] !== HISTORY_CONTRACT_VERSION ||
          pvcSpec?.storageClassName !== HISTORY_STORAGE_CLASS ||
          accessModes.length !== 1 ||
          accessModes[0] !== "ReadWriteOnce" ||
          requests?.storage !== `${HISTORY_STORAGE_MIB}Mi`
        ) {
          throw new RuntimeProviderError(
            "invalid_spec",
            "renderer returned an invalid stable private-history PVC",
            "terminal",
          );
        }
        continue;
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
    const hostedSecrets = resources.filter(
      (resource) => resource.kind === "Secret" && resource.metadata.name === `${baseName}-runtime`,
    );
    const historyClaims = resources.filter((resource) => resource.kind === "PersistentVolumeClaim");
    if (hostedSecrets.length !== (spec.scriptoriumAssignment === undefined ? 0 : 1)) {
      throw new RuntimeProviderError(
        "invalid_spec",
        "renderer did not project the exact Hosted runtime assignment",
        "terminal",
      );
    }
    if (historyClaims.length !== (spec.scriptoriumAssignment === undefined ? 0 : 1))
      throw new RuntimeProviderError(
        "invalid_spec",
        "renderer did not return the stable private-history PVC",
        "terminal",
      );
    const deployment = resources.find((resource) => resource.kind === "Deployment");
    if (deployment === undefined || appContainerImage(deployment) !== spec.release.artifactRef) {
      throw new RuntimeProviderError(
        "invalid_spec",
        "renderer did not use the admitted immutable artifact",
        "terminal",
      );
    }
    const deploymentPodSpec = record(record(record(deployment)?.spec)?.template)?.spec;
    const imagePullSecrets = Array.isArray(record(deploymentPodSpec)?.imagePullSecrets)
      ? (record(deploymentPodSpec)?.imagePullSecrets as unknown[])
      : [];
    const expectedImagePullSecret =
      this.options.imagePullConfigJson === undefined ? undefined : `${baseName}-image-pull`;
    if (
      (expectedImagePullSecret === undefined && imagePullSecrets.length !== 0) ||
      (expectedImagePullSecret !== undefined &&
        (imagePullSecrets.length !== 1 ||
          record(imagePullSecrets[0])?.name !== expectedImagePullSecret))
    ) {
      throw new RuntimeProviderError(
        "invalid_spec",
        "renderer returned an unexpected image pull Secret reference",
        "terminal",
      );
    }
  }

  private imagePullSecretResource(spec: RunningInstanceSpec): KubernetesResource | undefined {
    const configJson = this.options.imagePullConfigJson;
    if (configJson === undefined) return undefined;
    const name = `${runtimeResourceName(spec.instanceId)}-image-pull`;
    return {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name,
        namespace: this.namespaceFor(spec.instanceId),
        labels: {
          ...resourceLabels(spec, spec.release.releaseId),
          "app.kubernetes.io/name": "scriptorium",
        },
      },
      type: "kubernetes.io/dockerconfigjson",
      data: { ".dockerconfigjson": Buffer.from(configJson, "utf8").toString("base64") },
    };
  }

  private assertImagePullSecretShape(
    value: unknown,
    identity: InstanceIdentity,
    namespaceName: string,
    name: string,
  ): void {
    const metadata = assertObjectOwned(value, identity, namespaceName, name);
    const secret = record(value);
    const data = record(secret?.data);
    if (
      metadata.labels["app.kubernetes.io/name"] !== "scriptorium" ||
      secret?.type !== "kubernetes.io/dockerconfigjson" ||
      data === undefined ||
      Object.keys(data).length !== 1 ||
      data[".dockerconfigjson"] === undefined
    ) {
      throw new RuntimeProviderError(
        "conflict",
        "owned image pull Secret has an unexpected shape",
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
            { force: true },
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
    const imagePullSecretName = `${runtimeResourceName(identity.instanceId)}-image-pull`;
    if (resource.kind === "Secret" && resource.metadata.name === imagePullSecretName) {
      this.assertImagePullSecretShape(
        current,
        identity,
        resource.metadata.namespace,
        imagePullSecretName,
      );
    }
    if (metadata.deleting)
      throw new RuntimeProviderError("conflict", "runtime resource is deleting", "retryable");
    await beforeEffect();
    await this.options.api
      .applyConditional(
        resource,
        KUBERNETES_FIELD_MANAGER,
        preconditions(metadata).resourceVersion,
        signal,
        { force: true },
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
      { kind: "Service" as const, name: `${name}-control` },
      { kind: "NetworkPolicy" as const, name: `${name}-network` },
      { kind: "ResourceQuota" as const, name: `${name}-quota` },
      { kind: "LimitRange" as const, name: `${name}-limits` },
      { kind: "Secret" as const, name: `${name}-runtime` },
      { kind: "Secret" as const, name: `${name}-image-pull` },
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
      { kind: "Service" as const, name: `${name}-control` },
      { kind: "NetworkPolicy" as const, name: `${name}-network` },
      { kind: "ResourceQuota" as const, name: `${name}-quota` },
      { kind: "LimitRange" as const, name: `${name}-limits` },
      { kind: "Secret" as const, name: `${name}-runtime` },
      { kind: "Secret" as const, name: `${name}-image-pull` },
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

function assertSupportedLegacyHistory(snapshot: HistorySnapshot): void {
  if (
    snapshot.files.length > 1 ||
    (snapshot.files.length === 1 && snapshot.files[0]?.path !== LEGACY_HISTORY_CURSOR_PATH)
  ) {
    throw new RuntimeProviderError(
      "conflict",
      "legacy private history contains unsupported files; stopping is blocked to preserve its data",
      "terminal",
    );
  }
}

export function createInClusterKubernetesRuntimeProvider(
  options: InClusterKubernetesRuntimeProviderOptions,
): KubernetesRuntimeProvider {
  const renderer = createKubernetesResourceRenderer({
    ...options.rendererOptions,
    namespacePrefix: options.namespacePrefix,
    clusterId: options.clusterId,
    includeImagePullSecret: options.imagePullConfigJson !== undefined,
  });
  return new KubernetesRuntimeProvider({
    ...options,
    api: createInClusterKubernetesApi(),
    renderer,
  });
}
