import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  KubernetesRuntimeProvider,
  createKubernetesResourceRenderer,
  managedLabels,
  parseRuntimeInstanceId,
  parseRuntimeReleaseId,
  parseRuntimeRepositoryId,
  runtimeNamespaceName,
  runtimeResourceName,
} from "../src/index.js";
import { KubernetesApiError } from "../src/kubernetes/client.js";
import type { KubernetesApi } from "../src/kubernetes/client.js";
import type {
  KubernetesListResult,
  KubernetesNamespace,
  KubernetesObjectPreconditions,
  KubernetesResource,
  KubernetesResourceReference,
  KubernetesWatchEvent,
} from "../src/kubernetes/types.js";
import type {
  InstanceIdentity,
  RuntimeResourceQuantities,
  RunningInstanceSpec,
} from "../src/types.js";
import type {
  KubernetesCapacityReservation,
  KubernetesCapacityReservationSnapshot,
  KubernetesCapacityReservationSource,
} from "../src/kubernetes/capacity.js";

const INSTANCE_ID = parseRuntimeInstanceId("ins_00000000000000000000000001");
const RELEASE_ID = parseRuntimeReleaseId("rel_00000000000000000000000001");
const REPOSITORY_ID = parseRuntimeRepositoryId(731);
const CLUSTER_ID = "clu_00000000000000000000000001";
const PREFIX = "praetorium-instances";
const NAMESPACE = runtimeNamespaceName(PREFIX, INSTANCE_ID);
const DEPLOYMENT = runtimeResourceName(INSTANCE_ID);
const INDEX_DIGEST = `sha256:${"a".repeat(64)}`;
const CHILD_DIGEST = `sha256:${"b".repeat(64)}`;
const HOST = "i-00000000000000000000000001.praetorium.example.test";
const RESTRICTED_POD_SECURITY_LABELS = {
  "pod-security.kubernetes.io/enforce": "restricted",
  "pod-security.kubernetes.io/audit": "restricted",
  "pod-security.kubernetes.io/warn": "restricted",
} as const;
const POD_SECURITY_MODES = ["enforce", "audit", "warn"] as const;
const RESOURCE: RuntimeResourceQuantities = {
  cpuMilli: 500,
  memoryMiB: 512,
  ephemeralStorageMiB: 1024,
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function key(kind: string, namespace: string, name: string): string {
  return `${kind}/${namespace}/${name}`;
}

function identity(epoch = 1, generation = 1): InstanceIdentity {
  return {
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    runtimeEpoch: epoch,
    generation,
    clusterId: CLUSTER_ID,
  };
}

function ownedTenantNamespace(extraLabels: Readonly<Record<string, string>> = {}) {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: NAMESPACE,
      uid: "owned-namespace",
      resourceVersion: "5",
      labels: {
        ...managedLabels({
          instanceId: INSTANCE_ID,
          repositoryId: REPOSITORY_ID,
          runtimeEpoch: 1,
          generation: 1,
          releaseId: RELEASE_ID,
        }),
        "arcadia.io/runtime-cluster-id": CLUSTER_ID,
        ...RESTRICTED_POD_SECURITY_LABELS,
        ...extraLabels,
      },
    },
  };
}

function spec(epoch = 1, generation = 1): RunningInstanceSpec {
  return {
    ...identity(epoch, generation),
    release: {
      releaseId: RELEASE_ID,
      imageDigest: INDEX_DIGEST,
      platformManifestDigest: CHILD_DIGEST,
      artifactRef: `ghcr.io/praetorium/scriptorium@${INDEX_DIGEST}`,
    },
    resourceProfile: { id: "small", request: RESOURCE },
    hostname: HOST,
    runtimeConfig: {},
    application: {
      httpPort: 3847,
      livenessPath: "/healthz",
      readinessPath: "/readyz",
      metadataPath: "/platform/metadata",
      shutdownPath: "/platform/shutdown",
      shutdownTimeoutSeconds: 45,
      platformControlPaths: {
        status: "/api/platform/v1/status",
        quiesce: "/api/platform/v1/quiesce",
        resume: "/api/platform/v1/resume",
      },
    },
  };
}

class FakeKubernetesApi implements KubernetesApi {
  readonly objects = new Map<string, unknown>();
  readonly namespaces = new Map<string, unknown>();
  readonly writes: string[] = [];
  readonly gets: KubernetesResourceReference[] = [];
  readonly deletes: KubernetesResourceReference[] = [];
  readonly deletePreconditions: Array<{
    readonly reference: KubernetesResourceReference;
    readonly preconditions: KubernetesObjectPreconditions;
  }> = [];
  readonly listCalls: Array<{ kind: string; namespace: string; selector: string }> = [];
  invalidPodListVersion = false;
  endpointMutation: ((resource: KubernetesResource) => KubernetesResource) | null = null;
  onEndpointWrite: (() => void) | null = null;
  private revision = 1;
  private heldCreate: {
    readonly kind: string;
    readonly gate: Promise<void>;
    readonly release: () => void;
    readonly entered: () => void;
    readonly enteredPromise: Promise<void>;
  } | null = null;

  holdNextCreate(kind: string): { readonly entered: Promise<void>; readonly release: () => void } {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    this.heldCreate = { kind, gate, release, entered, enteredPromise };
    return { entered: enteredPromise, release };
  }

  addNode(allocatable = { cpu: "4", memory: "8Gi", "ephemeral-storage": "20Gi" }): void {
    this.objects.set(key("Node", "", "node-a"), {
      apiVersion: "v1",
      kind: "Node",
      metadata: { name: "node-a", uid: "node-uid", resourceVersion: String(this.revision) },
      spec: { taints: [] },
      status: {
        conditions: [{ type: "Ready", status: "True" }],
        allocatable,
      },
    });
  }

  getNamespace(name: string): Promise<unknown> {
    const value = this.namespaces.get(name);
    if (value === undefined) throw new KubernetesApiError(404, "NotFound");
    return Promise.resolve(value);
  }

  get(reference: KubernetesResourceReference): Promise<unknown> {
    this.gets.push(reference);
    const value = this.objects.get(key(reference.kind, reference.namespace, reference.name));
    if (value === undefined) throw new KubernetesApiError(404, "NotFound");
    return Promise.resolve(value);
  }

  list(
    kind:
      | "Node"
      | "Pod"
      | "ConfigMap"
      | "Deployment"
      | "IngressRoute"
      | "LimitRange"
      | "NetworkPolicy"
      | "ResourceQuota"
      | "RoleBinding"
      | "Secret"
      | "ServiceAccount"
      | "Service",
    namespace: string,
    labelSelector: string,
  ): Promise<KubernetesListResult> {
    this.listCalls.push({ kind, namespace, selector: labelSelector });
    const all = [...this.objects.entries()]
      .filter(([entry]) => entry.startsWith(`${kind}/`))
      .map(([, value]) => value)
      .filter(
        (value) => namespace.length === 0 || record(record(value).metadata).namespace === namespace,
      );
    return Promise.resolve({
      items: all,
      resourceVersion: this.invalidPodListVersion && kind === "Pod" ? null : String(this.revision),
      nextCursor: null,
    });
  }

  async apply(resource: KubernetesResource): Promise<unknown> {
    return this.put(resource.kind, resource.metadata.namespace, resource.metadata.name, resource);
  }

  async create(resource: KubernetesResource): Promise<unknown> {
    const held = this.heldCreate;
    if (held !== null && held.kind === resource.kind) {
      this.heldCreate = null;
      held.entered();
      await held.gate;
    }
    const objectKey = key(resource.kind, resource.metadata.namespace, resource.metadata.name);
    if (this.objects.has(objectKey)) throw new KubernetesApiError(409, "AlreadyExists");
    return this.put(resource.kind, resource.metadata.namespace, resource.metadata.name, resource);
  }

  async applyConditional(resource: KubernetesResource): Promise<unknown> {
    return this.put(resource.kind, resource.metadata.namespace, resource.metadata.name, resource);
  }

  async delete(reference: KubernetesResourceReference): Promise<void> {
    this.deletes.push(reference);
    this.objects.delete(key(reference.kind, reference.namespace, reference.name));
    this.writes.push(`delete:${reference.kind}`);
    this.revision += 1;
  }

  deleteConditional(
    reference: KubernetesResourceReference,
    preconditions: KubernetesObjectPreconditions,
  ): Promise<void> {
    this.deletePreconditions.push({ reference, preconditions });
    return this.delete(reference);
  }

  createNamespace(namespace: KubernetesNamespace): Promise<unknown> {
    if (this.namespaces.has(namespace.metadata.name))
      throw new KubernetesApiError(409, "AlreadyExists");
    const value = {
      ...namespace,
      metadata: {
        ...namespace.metadata,
        uid: `namespace-${this.revision}`,
        resourceVersion: String(this.revision),
      },
    };
    this.namespaces.set(namespace.metadata.name, value);
    this.writes.push("create:Namespace");
    this.revision += 1;
    return Promise.resolve(value);
  }

  applyNamespaceConditional(namespace: KubernetesNamespace): Promise<unknown> {
    return this.createNamespace(namespace);
  }

  deleteNamespaceConditional(name: string): Promise<void> {
    this.namespaces.delete(name);
    this.writes.push("delete:Namespace");
    this.revision += 1;
    return Promise.resolve();
  }

  async *watch(): AsyncIterable<KubernetesWatchEvent> {
    yield* [];
  }

  addWriterPod(runtimeSpec: RunningInstanceSpec): void {
    const deployment = this.objects.get(key("Deployment", NAMESPACE, DEPLOYMENT));
    if (deployment !== undefined) {
      this.objects.set(key("Deployment", NAMESPACE, DEPLOYMENT), {
        ...record(deployment),
        status: { readyReplicas: 1 },
      });
    }
    const podTemplate = record(record(record(deployment).spec).template);
    const podSpec = record(podTemplate.spec);
    const labels = record(record(podTemplate.metadata).labels);
    this.revision += 1;
    this.objects.set(key("Pod", NAMESPACE, `writer-${runtimeSpec.runtimeEpoch}`), {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: `writer-${runtimeSpec.runtimeEpoch}`,
        namespace: NAMESPACE,
        uid: `pod-${runtimeSpec.runtimeEpoch}`,
        resourceVersion: String(this.revision),
        labels,
      },
      spec: { ...podSpec, nodeName: "node-a" },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: [
          {
            name: "scriptorium",
            imageID: `containerd://ghcr.io/praetorium/scriptorium@${CHILD_DIGEST}`,
          },
        ],
      },
    });
  }

  private put(kind: string, namespace: string, name: string, resource: unknown): unknown {
    if (kind === "IngressRoute") {
      this.onEndpointWrite?.();
      if (this.endpointMutation !== null) {
        resource = this.endpointMutation(resource as KubernetesResource);
      }
    }
    this.revision += 1;
    const value = {
      ...record(resource),
      metadata: {
        ...record(record(resource).metadata),
        namespace,
        name,
        uid: `uid-${kind}-${name}`,
        resourceVersion: String(this.revision),
      },
    };
    this.objects.set(key(kind, namespace, name), value);
    this.writes.push(`write:${kind}`);
    return value;
  }
}

class FakeReservations implements KubernetesCapacityReservationSource {
  snapshot: KubernetesCapacityReservationSnapshot = {
    clusterId: CLUSTER_ID,
    capacityEpoch: 0,
    observedAt: 0,
    complete: false,
    capacity: null,
    representedReservationIds: [],
    reservations: [],
  };
  rejectRecord = false;

  async currentReservations(): Promise<KubernetesCapacityReservationSnapshot> {
    return this.snapshot;
  }

  async recordCapacitySnapshot(input: {
    readonly clusterId: string;
    readonly observedAt: number;
    readonly complete: boolean;
    readonly capacity: {
      readonly allocatable: RuntimeResourceQuantities;
      readonly requested: RuntimeResourceQuantities;
      readonly nodeResourceVersion: string;
      readonly podResourceVersion: string;
    };
    readonly representedReservationIds: readonly string[];
  }): Promise<number | null> {
    if (this.rejectRecord || input.observedAt <= this.snapshot.observedAt) return null;
    const represented = new Set(input.representedReservationIds);
    this.snapshot = {
      clusterId: input.clusterId,
      capacityEpoch: this.snapshot.capacityEpoch + 1,
      observedAt: input.observedAt,
      complete: input.complete,
      capacity: input.capacity,
      representedReservationIds: [...represented].sort(),
      reservations: this.snapshot.reservations.map((row) => ({
        ...row,
        status: represented.has(row.reservationId) ? "allocated" : "reserved",
      })),
    };
    return this.snapshot.capacityEpoch;
  }
}

function targetReservations(): FakeReservations {
  const source = new FakeReservations();
  source.snapshot = { ...source.snapshot, reservations: [reservation()] };
  return source;
}

function provider(
  api: FakeKubernetesApi,
  reservations = targetReservations(),
  now = () => Date.now(),
) {
  const renderer = createKubernetesResourceRenderer({
    namespacePrefix: PREFIX,
    clusterId: CLUSTER_ID,
    ingressNamespace: "traefik",
    instanceAccessNamespace: "praetorium-system",
    instanceAccessService: "instance-access",
    controlNamespace: "praetorium-system",
    controlService: "provisioner",
    maximumResources: { cpuMilli: 2_000, memoryMiB: 2_048, ephemeralStorageMiB: 4_096 },
  });
  return new KubernetesRuntimeProvider({
    api,
    namespacePrefix: PREFIX,
    clusterId: CLUSTER_ID,
    renderer,
    reservations,
    now,
    maxCapacityAgeMs: 30_000,
  });
}

function reservation(
  overrides: Partial<KubernetesCapacityReservation> = {},
): KubernetesCapacityReservation {
  return {
    reservationId: "reservation-1",
    clusterId: CLUSTER_ID,
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    runtimeEpoch: 1,
    generation: 1,
    resources: RESOURCE,
    status: "reserved",
    ...overrides,
  };
}

describe("Kubernetes runtime provider", () => {
  it("renders one constrained disk-backed writer and keeps route activation separate", () => {
    const resources = createKubernetesResourceRenderer({
      namespacePrefix: PREFIX,
      clusterId: CLUSTER_ID,
      ingressNamespace: "traefik",
      instanceAccessNamespace: "praetorium-system",
      instanceAccessService: "instance-access",
      controlNamespace: "praetorium-system",
      controlService: "provisioner",
      maximumResources: { cpuMilli: 2_000, memoryMiB: 2_048, ephemeralStorageMiB: 4_096 },
    }).renderRunning(spec());
    const deployment = resources.find((resource) => resource.kind === "Deployment");
    const template = record(record(record(deployment).spec).template);
    const podSpec = record(template.spec);
    const container = record((podSpec.containers as unknown[])[0]);
    const policy = record(resources.find((resource) => resource.kind === "NetworkPolicy")?.spec);
    const ingress = policy.ingress as unknown[];
    const egress = policy.egress as unknown[];

    expect(resources.map((resource) => resource.kind)).not.toContain("IngressRoute");
    expect(resources.map((resource) => resource.kind)).not.toContain("PersistentVolumeClaim");
    expect(podSpec.automountServiceAccountToken).toBe(false);
    expect(podSpec.tolerations).toEqual([
      { key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute" },
      { key: "node.kubernetes.io/unreachable", operator: "Exists", effect: "NoExecute" },
    ]);
    expect(podSpec.serviceAccountName).toBe(`${DEPLOYMENT}-app`);
    expect(podSpec.containers).toHaveLength(1);
    expect(container.image).toBe(spec().release?.artifactRef);
    expect(record(record(deployment).metadata).labels).toMatchObject({
      "arcadia.io/instance-id": INSTANCE_ID,
      "praetorium.io/repository-id": String(REPOSITORY_ID),
      "praetorium.io/runtime-epoch": "1",
      "arcadia.io/generation": "1",
      "arcadia.io/runtime-cluster-id": CLUSTER_ID,
    });
    expect(record(container.securityContext)).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(
      (podSpec.volumes as unknown[]).map((volume) => record(record(volume).emptyDir).sizeLimit),
    ).toEqual(["1024Mi", "1024Mi"]);
    expect((container.env as unknown[] | undefined) ?? []).toHaveLength(0);
    expect(ingress).toHaveLength(3);
    expect(
      ingress.map((rule) =>
        (record(rule).ports as unknown[]).map((item) => ({
          protocol: record(item).protocol,
          port: record(item).port,
        })),
      ),
    ).toEqual(Array.from({ length: 3 }, () => [{ protocol: "TCP", port: 3847 }]));
    expect(record(ingress[2]).from).toEqual([
      {
        namespaceSelector: {
          matchLabels: { "kubernetes.io/metadata.name": "praetorium-system" },
        },
        podSelector: { matchLabels: { "app.kubernetes.io/name": "provisioner" } },
      },
    ]);
    expect(JSON.stringify(ingress)).not.toContain('"port":8080');
    expect(JSON.stringify(egress)).toContain("168.63.129.16/32");
    expect(JSON.stringify(egress)).toContain('"port":443');
    const publicRule = record(egress[1]);
    const ipBlocks = publicRule.to as unknown[];
    const ipv4Block = ipBlocks
      .map((item) => record(record(item).ipBlock))
      .find((item) => item.cidr === "0.0.0.0/0");
    expect(ipv4Block?.except).toEqual([
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.0.0.0/24",
      "192.168.0.0/16",
      "168.63.129.16/32",
      "198.18.0.0/15",
      "224.0.0.0/4",
      "240.0.0.0/4",
    ]);
    const ipv6Block = ipBlocks
      .map((item) => record(record(item).ipBlock))
      .find((item) => item.cidr === "::/0");
    expect(ipv6Block?.except).toEqual([
      "::/128",
      "::1/128",
      "::/96",
      "::ffff:0:0/96",
      "2001:db8::/32",
      "fc00::/7",
      "fec0::/10",
      "fe80::/10",
      "ff00::/8",
    ]);
    expect((record(egress[0]).ports as unknown[]).map((item) => record(item).port)).toEqual([
      53, 53,
    ]);

    const revision = "rev_4af7c18c-66c1-4aab-b24e-78b6aaf5";
    const revisionResources = createKubernetesResourceRenderer({
      namespacePrefix: PREFIX,
      clusterId: CLUSTER_ID,
      ingressNamespace: "traefik",
      instanceAccessNamespace: "praetorium-system",
      instanceAccessService: "instance-access",
      controlNamespace: "praetorium-system",
      controlService: "provisioner",
      maximumResources: { cpuMilli: 2_000, memoryMiB: 2_048, ephemeralStorageMiB: 4_096 },
    }).renderRunning({
      ...spec(),
      release: { ...spec().release!, releaseId: parseRuntimeReleaseId(revision) },
    });
    expect(
      record(revisionResources.find((resource) => resource.kind === "Deployment")?.metadata.labels)[
        "arcadia.io/release-id"
      ],
    ).toBe(revision);
  });

  it("rejects a control ingress peer outside the trusted Provisioner identity", () => {
    const options = {
      namespacePrefix: PREFIX,
      clusterId: CLUSTER_ID,
      ingressNamespace: "traefik",
      instanceAccessNamespace: "praetorium-system",
      instanceAccessService: "instance-access",
      controlNamespace: "praetorium-system",
      controlService: "provisioner",
      maximumResources: { cpuMilli: 2_000, memoryMiB: 2_048, ephemeralStorageMiB: 4_096 },
    };
    expect(() =>
      createKubernetesResourceRenderer({ ...options, controlNamespace: "tenant-namespace" }),
    ).toThrow("Provisioner control service identity is invalid");
    expect(() =>
      createKubernetesResourceRenderer({ ...options, controlService: "any-service" }),
    ).toThrow("Provisioner control service identity is invalid");
  });

  it("records complete live capacity and CAS-matches exact reservation identities to Pods", async () => {
    let time = 100_000;
    const now = () => ++time;
    const api = new FakeKubernetesApi();
    api.addNode();
    const reservations = new FakeReservations();
    reservations.snapshot = { ...reservations.snapshot, reservations: [reservation()] };
    const runtime = provider(api, reservations, now);

    const before = await runtime.getCapacitySnapshot();
    expect(before.authoritative).toBe(true);
    expect(before.reserved).toEqual(RESOURCE);
    expect(before.cpuMilli).toBe(3_500);
    expect(reservations.snapshot.complete).toBe(true);
    expect(reservations.snapshot.capacity?.nodeResourceVersion).toBeTruthy();
    expect(reservations.snapshot.representedReservationIds).toEqual([]);

    const app = spec();
    api.createNamespace({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: NAMESPACE,
        labels: {
          ...managedLabels({
            instanceId: INSTANCE_ID,
            repositoryId: REPOSITORY_ID,
            runtimeEpoch: 1,
            generation: 1,
            releaseId: RELEASE_ID,
          }),
          "arcadia.io/runtime-cluster-id": CLUSTER_ID,
          ...RESTRICTED_POD_SECURITY_LABELS,
        },
      },
    });
    const renderer = createKubernetesResourceRenderer({
      namespacePrefix: PREFIX,
      clusterId: CLUSTER_ID,
      ingressNamespace: "traefik",
      instanceAccessNamespace: "praetorium-system",
      instanceAccessService: "instance-access",
      controlNamespace: "praetorium-system",
      controlService: "provisioner",
      maximumResources: { cpuMilli: 2_000, memoryMiB: 2_048, ephemeralStorageMiB: 4_096 },
    });
    const deployment = renderer
      .renderRunning(app)
      .find((resource) => resource.kind === "Deployment");
    await api.create(deployment!);
    api.addWriterPod(app);

    const after = await runtime.getCapacitySnapshot();
    expect(reservations.snapshot.representedReservationIds).toEqual(["reservation-1"]);
    expect(reservations.snapshot.reservations[0]?.status).toBe("allocated");
    expect(after.requested).toEqual(RESOURCE);
    expect(after.reserved).toEqual({ cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 });
    expect(after.cpuMilli).toBe(3_500);
  });

  it("fails closed when D1 does not commit the live capacity observation", async () => {
    const api = new FakeKubernetesApi();
    api.addNode();
    const reservations = new FakeReservations();
    reservations.rejectRecord = true;
    await expect(
      provider(api, reservations, () => 100_000).getCapacitySnapshot(),
    ).rejects.toMatchObject({ code: "capacity" });
  });

  it("fails closed when a complete Pod resourceVersion or fresh sampling window is unavailable", async () => {
    const invalidVersionApi = new FakeKubernetesApi();
    invalidVersionApi.addNode();
    invalidVersionApi.invalidPodListVersion = true;
    await expect(
      provider(invalidVersionApi, new FakeReservations(), () => 100_000).getCapacitySnapshot(),
    ).rejects.toMatchObject({ code: "capacity" });

    const staleApi = new FakeKubernetesApi();
    staleApi.addNode();
    const observedTimes = [100_000, 130_001];
    await expect(
      provider(
        staleApi,
        new FakeReservations(),
        () => observedTimes.shift() ?? 130_001,
      ).getCapacitySnapshot(),
    ).rejects.toMatchObject({ code: "capacity" });
  });

  it("admits an exactly-full target only against its own exact pre-existing reservation", async () => {
    const api = new FakeKubernetesApi();
    api.addNode({ cpu: "500m", memory: "512Mi", "ephemeral-storage": "1024Mi" });
    const result = await provider(api, targetReservations(), () => 100_000).ensureRunning(
      spec(),
      new AbortController().signal,
      () => undefined,
    );
    expect(result.status).toBe("pending");
    expect(api.writes).toContain("create:Namespace");
    expect(record(record(api.namespaces.get(NAMESPACE)).metadata).labels).toMatchObject(
      RESTRICTED_POD_SECURITY_LABELS,
    );
  });

  it("censuses all namespace Pods without an epoch selector and blocks replacement until old Pods are absent", async () => {
    const api = new FakeKubernetesApi();
    api.addNode();
    const runtime = provider(api, targetReservations(), () => 100_000);
    await runtime.ensureRunning(spec(1), new AbortController().signal, () => undefined);
    api.addWriterPod(spec(1));
    const beforeWrites = api.writes.length;

    const replacement = await runtime.ensureRunning(
      spec(2),
      new AbortController().signal,
      () => undefined,
    );
    expect(replacement.status).toBe("pending");
    expect(replacement.observation.writerCensus.queriedPodCount).toBe(1);
    expect(replacement.observation.writerCensus.pods[0]).toMatchObject({
      uid: "pod-1",
      runtimeEpoch: 1,
      generation: 1,
      ready: true,
    });
    expect(api.writes).toHaveLength(beforeWrites);
    expect(
      api.listCalls.some(
        (call) => call.kind === "Pod" && call.namespace === NAMESPACE && call.selector === "",
      ),
    ).toBe(true);
  });

  it("fails closed on an unowned namespace Pod or duplicate writer generation", async () => {
    const api = new FakeKubernetesApi();
    api.addNode();
    const runtime = provider(api, targetReservations(), () => 100_000);
    await runtime.ensureRunning(spec(), new AbortController().signal, () => undefined);
    api.addWriterPod(spec());
    const podKey = key("Pod", NAMESPACE, "writer-1");
    const pod = api.objects.get(podKey);
    api.objects.set(podKey, {
      ...record(pod),
      metadata: { ...record(record(pod).metadata), labels: {} },
    });
    const beforeWrites = api.writes.length;
    const unknown = await runtime.ensureRunning(
      spec(2),
      new AbortController().signal,
      () => undefined,
    );
    expect(unknown.status).toBe("pending");
    expect(unknown.observation.writerState).toBe("unknown");
    expect(api.writes).toHaveLength(beforeWrites);

    const duplicate = {
      ...record(pod),
      metadata: { ...record(record(pod).metadata), name: "writer-duplicate", uid: "pod-duplicate" },
    };
    api.objects.set(key("Pod", NAMESPACE, "writer-duplicate"), duplicate);
    api.objects.set(podKey, pod);
    const duplicateResult = await runtime.ensureRunning(
      spec(2),
      new AbortController().signal,
      () => undefined,
    );
    expect(duplicateResult.status).toBe("pending");
    expect(duplicateResult.observation.writerCensus.queriedPodCount).toBe(2);
    expect(api.writes).toHaveLength(beforeWrites);
  });

  it("does not let a delayed stale create overwrite a newer deployment revision", async () => {
    let time = 1_000_000;
    const now = () => ++time;
    const api = new FakeKubernetesApi();
    api.addNode();
    const reservations = targetReservations();
    reservations.snapshot = {
      ...reservations.snapshot,
      reservations: [
        reservation(),
        reservation({
          reservationId: "reservation-2",
          runtimeEpoch: 2,
          generation: 2,
        }),
      ],
    };
    const oldRuntime = provider(api, reservations, now);
    const held = api.holdNextCreate("Deployment");
    const oldWork = oldRuntime.ensureRunning(
      spec(1, 1),
      new AbortController().signal,
      () => undefined,
    );
    await held.entered;

    const newRuntime = provider(api, reservations, now);
    await newRuntime.ensureRunning(spec(2, 2), new AbortController().signal, () => undefined);
    held.release();

    await expect(oldWork).rejects.toMatchObject({ code: "conflict" });
    const deployment = record(
      await api.get({ kind: "Deployment", namespace: NAMESPACE, name: DEPLOYMENT }),
    );
    expect(record(record(deployment.metadata).labels)["praetorium.io/runtime-epoch"]).toBe("2");
    expect(record(record(deployment.metadata).labels)["arcadia.io/generation"]).toBe("2");
  });

  it("fences each mutation and rejects wrong cluster identity before effects", async () => {
    const api = new FakeKubernetesApi();
    api.addNode();
    const runtime = provider(api, targetReservations(), () => 100_000);
    await expect(
      runtime.ensureRunning(
        { ...spec(), clusterId: "clu_00000000000000000000000002" },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "invalid_spec" });
    expect(api.writes).toHaveLength(0);

    let checks = 0;
    await expect(
      runtime.ensureRunning(spec(), new AbortController().signal, () => {
        checks += 1;
        if (checks === 2) throw new Error("operation lease expired");
      }),
    ).rejects.toThrow("operation lease expired");
    expect(checks).toBe(2);
    expect(api.writes).toEqual(["create:Namespace"]);
  });

  it("checks the operation fence once before each Kubernetes write", async () => {
    const api = new FakeKubernetesApi();
    api.addNode();
    const runtime = provider(api, targetReservations(), () => 100_000);
    let fenceChecks = 0;
    await runtime.ensureRunning(spec(), new AbortController().signal, () => {
      fenceChecks += 1;
    });
    expect(api.writes.length).toBeGreaterThan(1);
    expect(fenceChecks).toBe(api.writes.length);
  });

  it("rejects a tenant namespace already owned by another repository before writes", async () => {
    const api = new FakeKubernetesApi();
    api.addNode();
    api.namespaces.set(NAMESPACE, {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: NAMESPACE,
        uid: "foreign-namespace",
        resourceVersion: "5",
        labels: {
          ...managedLabels({
            instanceId: INSTANCE_ID,
            repositoryId: parseRuntimeRepositoryId(732),
            runtimeEpoch: 1,
            generation: 1,
            releaseId: RELEASE_ID,
          }),
          "arcadia.io/runtime-cluster-id": CLUSTER_ID,
          ...RESTRICTED_POD_SECURITY_LABELS,
        },
      },
    });
    const runtime = provider(api, targetReservations(), () => 100_000);
    await expect(
      runtime.ensureRunning(spec(), new AbortController().signal, () => undefined),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(api.writes).toHaveLength(0);
  });

  it("rejects an existing tenant namespace missing or weakening any restricted PSA label without mutation", async () => {
    for (const label of Object.keys(RESTRICTED_POD_SECURITY_LABELS)) {
      for (const change of ["missing", "weakened"] as const) {
        const api = new FakeKubernetesApi();
        api.addNode();
        const labels: Record<string, string> = {
          ...managedLabels({
            instanceId: INSTANCE_ID,
            repositoryId: REPOSITORY_ID,
            runtimeEpoch: 1,
            generation: 1,
            releaseId: RELEASE_ID,
          }),
          "arcadia.io/runtime-cluster-id": CLUSTER_ID,
          ...RESTRICTED_POD_SECURITY_LABELS,
        };
        if (change === "missing") delete labels[label];
        else labels[label] = "baseline";
        const namespace = {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name: NAMESPACE,
            uid: "owned-namespace",
            resourceVersion: "5",
            labels,
          },
        };
        const originalNamespace = structuredClone(namespace);
        api.namespaces.set(NAMESPACE, namespace);

        await expect(
          provider(api, targetReservations(), () => 100_000).ensureRunning(
            spec(),
            new AbortController().signal,
            () => undefined,
          ),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(api.writes).toEqual([]);
        expect(api.namespaces.get(NAMESPACE)).toEqual(originalNamespace);
      }
    }
  });

  it("accepts absent or latest PSA version labels for each mode in inspect and ensureRunning", async () => {
    for (const mode of POD_SECURITY_MODES) {
      for (const version of [undefined, "latest"] as const) {
        const api = new FakeKubernetesApi();
        api.addNode();
        const versionLabels =
          version === undefined ? {} : { [`pod-security.kubernetes.io/${mode}-version`]: version };
        const namespace = ownedTenantNamespace(versionLabels);
        const originalNamespace = structuredClone(namespace);
        api.namespaces.set(NAMESPACE, namespace);
        const runtime = provider(api, targetReservations(), () => 100_000);

        await expect(runtime.inspect(identity())).resolves.toMatchObject({ state: "absent" });
        const result = await runtime.ensureRunning(
          spec(),
          new AbortController().signal,
          () => undefined,
        );
        expect(result.status).toBe("pending");
        expect(api.writes).not.toContain("create:Namespace");
        expect(api.namespaces.get(NAMESPACE)).toEqual(originalNamespace);
      }
    }
  });

  it("rejects pinned or unknown PSA versions for every mode before writes", async () => {
    for (const mode of POD_SECURITY_MODES) {
      for (const version of ["v1.33", "future"] as const) {
        const api = new FakeKubernetesApi();
        api.addNode();
        const namespace = ownedTenantNamespace({
          [`pod-security.kubernetes.io/${mode}-version`]: version,
        });
        const originalNamespace = structuredClone(namespace);
        api.namespaces.set(NAMESPACE, namespace);
        const runtime = provider(api, targetReservations(), () => 100_000);

        await expect(runtime.inspect(identity())).rejects.toMatchObject({ code: "conflict" });
        await expect(
          runtime.ensureRunning(spec(), new AbortController().signal, () => undefined),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(api.writes).toEqual([]);
        expect(api.namespaces.get(NAMESPACE)).toEqual(originalNamespace);
      }
    }
  });

  it("grants tenant runtimes to the checked-in Praetorium provisioner service account", async () => {
    const manifest = readFileSync(
      new URL("../../../infrastructure/kubernetes/base/platform-services.yaml", import.meta.url),
      "utf8",
    );
    const serviceAccount = manifest.match(
      /^apiVersion:\s*v1\r?\nkind:\s*ServiceAccount\r?\nmetadata:\r?\n\s+name:\s*([^\s#]+)\r?\n\s+namespace:\s*([^\s#]+)/m,
    );
    const provisionerDeployment = manifest
      .split(/^---\s*$/m)
      .find(
        (document) =>
          /^kind:\s*Deployment\s*$/m.test(document) &&
          /^metadata:\r?\n\s+name:\s*praetorium-provisioner\s*$/m.test(document),
      );
    const deploymentNamespace = provisionerDeployment?.match(
      /^metadata:\r?\n\s+name:\s*praetorium-provisioner\r?\n\s+namespace:\s*([^\s#]+)/m,
    );
    const deploymentServiceAccount = provisionerDeployment?.match(
      /^\s+serviceAccountName:\s*([^\s#]+)/m,
    );
    expect(serviceAccount).not.toBeNull();
    expect(provisionerDeployment).toBeDefined();
    expect(deploymentNamespace?.[1]).toBe(serviceAccount?.[2]);
    expect(deploymentServiceAccount?.[1]).toBe(serviceAccount?.[1]);

    const api = new FakeKubernetesApi();
    api.addNode();
    const runtime = provider(api, targetReservations(), () => 100_000);
    await runtime.ensureRunning(spec(), new AbortController().signal, () => undefined);

    const binding = record(
      api.objects.get(key("RoleBinding", NAMESPACE, "praetorium-provisioner-runtime")),
    );
    expect(binding).toMatchObject({
      kind: "RoleBinding",
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "praetorium-provisioner-tenant-runtime",
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: serviceAccount?.[1],
          namespace: serviceAccount?.[2],
        },
      ],
    });
  });

  it.each([
    [
      "a different service account",
      [{ kind: "ServiceAccount", name: "other", namespace: "praetorium-system" }],
    ],
    [
      "an extra principal",
      [
        { kind: "ServiceAccount", name: "praetorium-provisioner", namespace: "praetorium-system" },
        { kind: "ServiceAccount", name: "other", namespace: "praetorium-system" },
      ],
    ],
  ])("rejects a tenant grant with %s", async (_description, subjects) => {
    const api = new FakeKubernetesApi();
    api.addNode();
    let time = 100_000;
    const runtime = provider(api, targetReservations(), () => ++time);
    await runtime.ensureRunning(spec(), new AbortController().signal, () => undefined);
    const bindingKey = key("RoleBinding", NAMESPACE, "praetorium-provisioner-runtime");
    const binding = record(api.objects.get(bindingKey));
    api.objects.set(bindingKey, { ...binding, subjects });
    const beforeWrites = [...api.writes];

    await expect(
      runtime.ensureRunning(spec(), new AbortController().signal, () => undefined),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(api.writes).toEqual(beforeWrites);
  });

  it("rejects resource profiles above the operator quota before rendering", () => {
    const renderer = createKubernetesResourceRenderer({
      namespacePrefix: PREFIX,
      clusterId: CLUSTER_ID,
      ingressNamespace: "traefik",
      instanceAccessNamespace: "praetorium-system",
      instanceAccessService: "instance-access",
      controlNamespace: "praetorium-system",
      controlService: "provisioner",
      maximumResources: { cpuMilli: 2_000, memoryMiB: 2_048, ephemeralStorageMiB: 4_096 },
    });
    expect(() =>
      renderer.renderRunning({
        ...spec(),
        resourceProfile: {
          id: "too-large",
          request: { cpuMilli: 2_001, memoryMiB: 512, ephemeralStorageMiB: 1024 },
        },
      }),
    ).toThrow("producer resource profile exceeds operator limits");
  });

  it("activates the route only after current application, auth, epoch, and image evidence", async () => {
    const time = 500_000;
    const now = () => time;
    const api = new FakeKubernetesApi();
    api.addNode();
    const runtime = provider(api, targetReservations(), now);
    await runtime.ensureRunning(spec(), new AbortController().signal, () => undefined);
    expect(api.objects.has(key("IngressRoute", NAMESPACE, DEPLOYMENT))).toBe(false);
    api.addWriterPod(spec());
    expect(api.objects.has(key("IngressRoute", NAMESPACE, DEPLOYMENT))).toBe(false);
    const evidence = {
      identity: identity(),
      actualImageDigest: CHILD_DIGEST,
      applicationProbe: { id: "app-probe-1", observedAt: time, ready: true as const },
      authProbe: { id: "auth-probe-1", observedAt: time, ready: true as const },
    };

    const activated = await runtime.activateEndpoint(
      spec(),
      evidence,
      new AbortController().signal,
      () => undefined,
    );
    expect(activated.endpoint).toBe(`https://${HOST}`);
    expect(api.objects.has(key("IngressRoute", NAMESPACE, DEPLOYMENT))).toBe(true);

    await expect(
      runtime.activateEndpoint(
        spec(),
        { ...evidence, authProbe: { ...evidence.authProbe, observedAt: time - 31_000 } },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      runtime.activateEndpoint(
        spec(),
        { ...evidence, actualImageDigest: INDEX_DIGEST },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("exposes the owned internal Service address for signed probes before route activation", async () => {
    const api = new FakeKubernetesApi();
    api.addNode();
    const runtime = provider(api, targetReservations(), () => 500_000);
    await runtime.ensureRunning(spec(), new AbortController().signal, () => undefined);
    api.addWriterPod(spec());

    await expect(runtime.getControlEndpoint(spec())).resolves.toBe(
      `http://${DEPLOYMENT}.${NAMESPACE}.svc.cluster.local:3847`,
    );
    expect(api.objects.has(key("IngressRoute", NAMESPACE, DEPLOYMENT))).toBe(false);
  });

  it.each(["missing", "wrong port"])(
    "fails closed when the internal control Service is %s",
    async (problem) => {
      const api = new FakeKubernetesApi();
      api.addNode();
      const runtime = provider(api, targetReservations(), () => 500_000);
      await runtime.ensureRunning(spec(), new AbortController().signal, () => undefined);
      api.addWriterPod(spec());
      const serviceKey = key("Service", NAMESPACE, DEPLOYMENT);
      if (problem === "missing") {
        api.objects.delete(serviceKey);
      } else {
        const service = record(api.objects.get(serviceKey));
        const serviceSpec = record(service.spec);
        const ports = serviceSpec.ports as unknown[];
        api.objects.set(serviceKey, {
          ...service,
          spec: {
            ...serviceSpec,
            ports: [{ ...record(ports[0]), port: 9999 }],
          },
        });
      }

      await expect(runtime.getControlEndpoint(spec())).rejects.toMatchObject({
        code: problem === "missing" ? "unavailable" : "conflict",
      });
    },
  );

  it.each([
    [
      "wrong host",
      (route: Record<string, unknown>) => ({ ...route, match: "Host(`other.example.test`)" }),
    ],
    [
      "wrong service port",
      (route: Record<string, unknown>) => ({
        ...route,
        services: [{ ...record((route.services as unknown[])[0]), port: 9999 }],
      }),
    ],
  ])("rejects and removes an endpoint with %s", async (_description, mutateRoute) => {
    const time = 500_000;
    const api = new FakeKubernetesApi();
    api.addNode();
    const runtime = provider(api, targetReservations(), () => time);
    await runtime.ensureRunning(spec(), new AbortController().signal, () => undefined);
    api.addWriterPod(spec());
    api.endpointMutation = (resource) => {
      const routeSpec = record(resource.spec);
      const routes = routeSpec.routes as unknown[];
      return {
        ...resource,
        spec: { ...routeSpec, routes: [mutateRoute(record(routes[0]))] },
      };
    };
    const evidence = {
      identity: identity(),
      actualImageDigest: CHILD_DIGEST,
      applicationProbe: { id: "app-probe-1", observedAt: time, ready: true as const },
      authProbe: { id: "auth-probe-1", observedAt: time, ready: true as const },
    };

    await expect(
      runtime.activateEndpoint(spec(), evidence, new AbortController().signal, () => undefined),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(api.objects.has(key("IngressRoute", NAMESPACE, DEPLOYMENT))).toBe(false);
  });

  it.each(["image", "readiness"])(
    "rejects and removes the endpoint when %s drifts during route apply",
    async (drift) => {
      const time = 500_000;
      const api = new FakeKubernetesApi();
      api.addNode();
      const runtime = provider(api, targetReservations(), () => time);
      await runtime.ensureRunning(spec(), new AbortController().signal, () => undefined);
      api.addWriterPod(spec());
      api.onEndpointWrite = () => {
        const podKey = key("Pod", NAMESPACE, "writer-1");
        const pod = record(api.objects.get(podKey));
        const status = record(pod.status);
        const containers = status.containerStatuses as unknown[];
        const conditions = status.conditions as unknown[];
        api.objects.set(podKey, {
          ...pod,
          status: {
            ...status,
            ...(drift === "image"
              ? {
                  containerStatuses: [
                    {
                      ...record(containers[0]),
                      imageID: `containerd://ghcr.io/praetorium/scriptorium@${INDEX_DIGEST}`,
                    },
                  ],
                }
              : {
                  conditions: conditions.map((condition) =>
                    record(condition).type === "Ready"
                      ? { ...record(condition), status: "False" }
                      : condition,
                  ),
                }),
          },
        });
      };
      const evidence = {
        identity: identity(),
        actualImageDigest: CHILD_DIGEST,
        applicationProbe: { id: "app-probe-1", observedAt: time, ready: true as const },
        authProbe: { id: "auth-probe-1", observedAt: time, ready: true as const },
      };

      await expect(
        runtime.activateEndpoint(spec(), evidence, new AbortController().signal, () => undefined),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(api.objects.has(key("IngressRoute", NAMESPACE, DEPLOYMENT))).toBe(false);
    },
  );

  it("removes only runtime workload resources after writer absence and retains the namespace", async () => {
    const api = new FakeKubernetesApi();
    api.addNode();
    const runtime = provider(api, targetReservations(), () => 900_000);
    await runtime.ensureRunning(spec(), new AbortController().signal, () => undefined);
    const result = await runtime.ensureRuntimeDeleted(
      identity(),
      new AbortController().signal,
      () => undefined,
    );
    expect(result.status).toBe("applied");
    expect(api.deletes.map((item) => item.kind)).toEqual([
      "Deployment",
      "Service",
      "NetworkPolicy",
      "ResourceQuota",
      "LimitRange",
      "ServiceAccount",
      "RoleBinding",
    ]);
    expect(api.deletes.at(-1)).toEqual({
      kind: "RoleBinding",
      namespace: NAMESPACE,
      name: "praetorium-provisioner-runtime",
    });
    const roleBindingReads = api.gets.filter((reference) => reference.kind === "RoleBinding");
    expect(roleBindingReads.length).toBeGreaterThanOrEqual(3);
    expect(
      roleBindingReads.every((reference) => reference.name === "praetorium-provisioner-runtime"),
    ).toBe(true);
    expect(api.objects.has(key("RoleBinding", NAMESPACE, "praetorium-provisioner-runtime"))).toBe(
      false,
    );
    expect(api.namespaces.has(NAMESPACE)).toBe(true);
    expect(api.writes).not.toContain("delete:Namespace");
  });
});
