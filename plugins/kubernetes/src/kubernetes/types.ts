import type { ReleaseSpec, RunningInstanceSpec, StoppedInstanceSpec } from "../types.js";
import type { ManagedRuntimeSummary } from "../types.js";

export const KUBERNETES_RESOURCE_KINDS = [
  "ConfigMap",
  "Deployment",
  "IngressRoute",
  "LimitRange",
  "NetworkPolicy",
  "ResourceQuota",
  "RoleBinding",
  "Secret",
  "ServiceAccount",
  "Service",
] as const;

export type KubernetesResourceKind = (typeof KUBERNETES_RESOURCE_KINDS)[number];
export type KubernetesReadableResourceKind = KubernetesResourceKind | "Node" | "Pod";

export interface KubernetesResourceMetadata {
  readonly name: string;
  readonly namespace: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, string>>;
  /** Set only from a fresh GET before a conditional update. */
  readonly resourceVersion?: string;
}

/** Constrained object shape kept inside the Kubernetes adapter. */
export interface KubernetesResource {
  readonly apiVersion: string;
  readonly kind: KubernetesResourceKind;
  readonly metadata: KubernetesResourceMetadata;
  readonly spec?: Readonly<Record<string, unknown>>;
  readonly data?: Readonly<Record<string, string>>;
  readonly stringData?: Readonly<Record<string, string>>;
  readonly type?: string;
  readonly automountServiceAccountToken?: boolean;
  readonly roleRef?: Readonly<Record<string, string>>;
  readonly subjects?: readonly Readonly<Record<string, string>>[];
}

export interface KubernetesNamespace {
  readonly apiVersion: "v1";
  readonly kind: "Namespace";
  readonly metadata: {
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly annotations?: Readonly<Record<string, string>>;
    /** Set only from a fresh GET before a conditional update. */
    readonly resourceVersion?: string;
  };
}

export interface KubernetesObjectPreconditions {
  readonly uid: string;
  readonly resourceVersion: string;
}

export interface KubernetesResourceRenderer {
  renderRunning(spec: RunningInstanceSpec): readonly KubernetesResource[];
  renderStopped(spec: StoppedInstanceSpec): readonly KubernetesResource[];
  renderRelease(spec: ReleaseSpec): readonly KubernetesResource[];
  renderEndpoint(spec: RunningInstanceSpec | ReleaseSpec): KubernetesResource;
}

export type KubernetesWatchEventType = "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK";

export interface KubernetesWatchEvent {
  readonly type: KubernetesWatchEventType;
  readonly object: unknown;
  readonly resourceVersion: string | null;
}

export interface KubernetesResourceReference {
  readonly kind: KubernetesReadableResourceKind;
  readonly namespace: string;
  readonly name: string;
}

export interface KubernetesListResult {
  readonly items: readonly unknown[];
  readonly resourceVersion: string | null;
  readonly nextCursor: string | null;
}

export interface KubernetesRuntimeWatchEvent {
  readonly type: KubernetesWatchEventType;
  readonly summary: ManagedRuntimeSummary;
  readonly resourceVersion: string | null;
}
