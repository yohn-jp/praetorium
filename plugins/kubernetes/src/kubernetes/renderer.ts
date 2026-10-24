import { RuntimeAssignmentSchema } from "@praetorium/contracts";
import { RuntimeProviderError } from "../errors.js";
import {
  CLUSTER_LABEL_KEY,
  GENERATION_LABEL_KEY,
  INSTANCE_LABEL_KEY,
  MANAGED_BY_LABEL_KEY,
  MANAGED_BY_LABEL_VALUE,
  OWNERSHIP_LABEL_KEY,
  OWNERSHIP_VERSION,
  PLATFORM_LABEL_KEY,
  PLATFORM_LABEL_VALUE,
  RUNTIME_EPOCH_LABEL_KEY,
  REPOSITORY_LABEL_KEY,
  managedLabels,
} from "../labels.js";
import { runtimeNamespaceName, runtimeResourceName } from "../naming.js";
import type {
  ReleaseSpec,
  RuntimeApplicationRequirements,
  RuntimeInstanceSpec,
  RuntimeResourceProfile,
  RuntimeResourceQuantities,
  RunningInstanceSpec,
  StoppedInstanceSpec,
} from "../types.js";
import type { KubernetesResource, KubernetesResourceRenderer } from "./types.js";
import { HISTORY_CONTRACT_VERSION, HISTORY_RESTORE_NODE_SCRIPT } from "./history.js";

const APPLICATION_LABEL_KEY = "app.kubernetes.io/name";
const APPLICATION_LABEL_VALUE = "scriptorium";
const RUNTIME_NODE_ROLE_LABEL_KEY = "praetorium.io/node-role";
const RUNTIME_NODE_ROLE_LABEL_VALUE = "runtime";
// Current Scriptorium Core OCI images declare USER node (UID:GID 1000:1000);
// `/data` in that image is owned by the same identity. Keep mounted emptyDirs
// writable for this non-root runtime while retaining explicit pod identity.
const SCRIPTORIUM_RUNTIME_UID = 1_000;
const SCRIPTORIUM_RUNTIME_GID = 1_000;
const HISTORY_STORAGE_CLASS = "local-path";

function historyResourceName(spec: RuntimeInstanceSpec): string {
  return `${runtimeResourceName(spec.instanceId)}-history`;
}

function historySeedName(spec: RuntimeInstanceSpec): string {
  return `${runtimeResourceName(spec.instanceId)}-history-seed`;
}

function historyLabels(spec: RuntimeInstanceSpec): Readonly<Record<string, string>> {
  return {
    [PLATFORM_LABEL_KEY]: PLATFORM_LABEL_VALUE,
    [MANAGED_BY_LABEL_KEY]: MANAGED_BY_LABEL_VALUE,
    [INSTANCE_LABEL_KEY]: spec.instanceId,
    [REPOSITORY_LABEL_KEY]: String(spec.repositoryId),
    [CLUSTER_LABEL_KEY]: spec.clusterId,
    [OWNERSHIP_LABEL_KEY]: OWNERSHIP_VERSION,
    [APPLICATION_LABEL_KEY]: APPLICATION_LABEL_VALUE,
  };
}

function historyMetadata(
  options: KubernetesResourceRendererOptions,
  spec: RuntimeInstanceSpec,
  name: string,
): KubernetesResource["metadata"] {
  return {
    name,
    namespace: namespace(spec, options.namespacePrefix),
    labels: historyLabels(spec),
    annotations: { "praetorium.io/history-contract": HISTORY_CONTRACT_VERSION },
  };
}

function historyClaim(
  options: KubernetesResourceRendererOptions,
  spec: RuntimeInstanceSpec,
): KubernetesResource {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: historyMetadata(options, spec, historyResourceName(spec)),
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: HISTORY_STORAGE_CLASS,
      resources: { requests: { storage: memory(spec.resourceProfile.request.ephemeralStorageMiB) } },
    },
  };
}

export interface KubernetesResourceRendererOptions {
  /** Prefix for deterministic per-instance tenant namespaces. */
  readonly namespacePrefix: string;
  readonly clusterId: string;
  readonly ingressNamespace: string;
  readonly instanceAccessNamespace: string;
  readonly instanceAccessService: string;
  /** Trusted Provisioner control namespace and app.kubernetes.io/name value. */
  readonly controlNamespace: string;
  readonly controlService: string;
  /** Hard operator ceilings; producer requests are checked against these. */
  readonly maximumResources: RuntimeResourceQuantities;
  /** Add the deterministic Provisioner-managed image pull Secret reference. */
  readonly includeImagePullSecret?: boolean;
}

function failInvalid(message: string): never {
  throw new RuntimeProviderError("invalid_spec", message, "terminal");
}

function validateQuantity(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) failInvalid(`runtime ${field} is invalid`);
}

function validateProfile(
  profile: RuntimeResourceProfile,
  maximum: RuntimeResourceQuantities,
): void {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(profile.id)) failInvalid("resource profile id is invalid");
  for (const key of ["cpuMilli", "memoryMiB", "ephemeralStorageMiB"] as const) {
    validateQuantity(profile.request[key], key);
    validateQuantity(maximum[key], `operator maximum ${key}`);
    if (profile.request[key] > maximum[key]) {
      throw new RuntimeProviderError(
        "capacity",
        "producer resource profile exceeds operator limits",
        "terminal",
      );
    }
  }
}

function cpu(value: number): string {
  return `${value}m`;
}

function memory(value: number): string {
  return `${value}Mi`;
}

function namespace(spec: RuntimeInstanceSpec, prefix: string): string {
  return runtimeNamespaceName(prefix, spec.instanceId);
}

function selector(instanceId: string): Readonly<Record<string, string>> {
  return { [INSTANCE_LABEL_KEY]: instanceId, [APPLICATION_LABEL_KEY]: APPLICATION_LABEL_VALUE };
}

function metadata(
  spec: RuntimeInstanceSpec,
  namespaceName: string,
  name: string,
  includeDigest = false,
): KubernetesResource["metadata"] {
  return {
    name,
    namespace: namespaceName,
    labels: {
      ...managedLabels({
        instanceId: spec.instanceId,
        repositoryId: spec.repositoryId,
        runtimeEpoch: spec.runtimeEpoch,
        generation: spec.generation,
        releaseId: spec.release?.releaseId ?? null,
      }),
      [CLUSTER_LABEL_KEY]: spec.clusterId,
      [APPLICATION_LABEL_KEY]: APPLICATION_LABEL_VALUE,
    },
    ...(!includeDigest || spec.release === null
      ? {}
      : { annotations: { "arcadia.io/release-digest": spec.release.imageDigest } }),
  };
}

function validateApplication(
  application: RuntimeApplicationRequirements | undefined,
): RuntimeApplicationRequirements {
  if (application === undefined) failInvalid("producer runtime metadata is missing");
  validateQuantity(application.httpPort, "listener port");
  if (
    application.httpPort > 65_535 ||
    !/^\/[A-Za-z0-9/_-]{1,126}$/.test(application.livenessPath) ||
    !/^\/[A-Za-z0-9/_-]{1,126}$/.test(application.readinessPath) ||
    !/^\/[A-Za-z0-9/_-]{1,126}$/.test(application.metadataPath) ||
    !/^\/[A-Za-z0-9/_-]{1,126}$/.test(application.shutdownPath) ||
    !Number.isSafeInteger(application.shutdownTimeoutSeconds) ||
    application.shutdownTimeoutSeconds < 1 ||
    application.shutdownTimeoutSeconds > 600 ||
    !/^\/[A-Za-z0-9/_-]{1,126}$/.test(application.platformControlPaths.status) ||
    !/^\/[A-Za-z0-9/_-]{1,126}$/.test(application.platformControlPaths.quiesce) ||
    !/^\/[A-Za-z0-9/_-]{1,126}$/.test(application.platformControlPaths.resume)
  ) {
    failInvalid("producer runtime metadata is invalid");
  }
  return application;
}

function runtimeProjection(
  options: KubernetesResourceRendererOptions,
  spec: RuntimeInstanceSpec,
): { readonly secretName: string; readonly resource: KubernetesResource } | null {
  const assignmentInput = spec.scriptoriumAssignment;
  const proof = spec.runtimeIdentityProof;
  if (assignmentInput === undefined && proof === undefined) return null;
  if (assignmentInput === undefined || proof === undefined)
    failInvalid("hosted runtime assignment and identity proof must be supplied together");
  let assignment: ReturnType<typeof RuntimeAssignmentSchema.parse>;
  try {
    assignment = RuntimeAssignmentSchema.parse(assignmentInput);
  } catch {
    failInvalid("hosted runtime assignment is invalid");
  }
  if (
    assignment.instanceId !== (spec.physicalInstanceId ?? spec.instanceId) ||
    assignment.repositoryId !== spec.repositoryId ||
    assignment.runtimeEpoch !== spec.runtimeEpoch ||
    spec.release === null ||
    assignment.imageDigest !== spec.release.imageDigest
  )
    failInvalid("hosted runtime assignment does not match the admitted image and identity");
  if (
    proof.length < 16 ||
    proof.length > 4_096 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(proof)
  )
    failInvalid("hosted runtime identity proof is invalid");

  const namespaceName = namespace(spec, options.namespacePrefix);
  const baseName = runtimeResourceName(spec.instanceId);
  const secretName = `${baseName}-runtime`;
  return {
    secretName,
    resource: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: metadata(spec, namespaceName, secretName),
      type: "Opaque",
      stringData: {
        "runtime-assignment.json": JSON.stringify(assignment),
        "runtime-identity.jwt": proof,
      },
    },
  };
}

function validateArtifact(spec: RuntimeInstanceSpec): void {
  if (
    spec.release === null ||
    !/^sha256:[0-9a-f]{64}$/.test(spec.release.imageDigest) ||
    !/^[a-z0-9][a-z0-9./:_-]{0,254}@sha256:[0-9a-f]{64}$/.test(spec.release.artifactRef) ||
    !spec.release.artifactRef.endsWith(`@${spec.release.imageDigest}`)
  ) {
    failInvalid("an admitted immutable runtime artifact is required");
  }
}

function validateHostname(hostname: string | null): string {
  if (
    hostname === null ||
    hostname.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(hostname)
  ) {
    failInvalid("instance hostname is unavailable");
  }
  return hostname;
}

function baseResources(
  options: KubernetesResourceRendererOptions,
  spec: RuntimeInstanceSpec,
): KubernetesResource[] {
  const ns = namespace(spec, options.namespacePrefix);
  const name = runtimeResourceName(spec.instanceId);
  const app = validateApplication(spec.application);
  validateProfile(spec.resourceProfile, options.maximumResources);
  validateHostname(spec.hostname);
  const labels = selector(spec.instanceId);
  const profile = spec.resourceProfile.request;
  const limits = options.maximumResources;
  return [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: metadata(spec, ns, `${name}-app`),
      automountServiceAccountToken: false,
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: metadata(spec, ns, name),
      spec: {
        type: "ClusterIP",
        selector: labels,
        ports: [{ name: "http", port: app.httpPort, targetPort: "http", protocol: "TCP" }],
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: metadata(spec, ns, `${name}-control`),
      spec: {
        type: "ClusterIP",
        publishNotReadyAddresses: true,
        selector: {
          [INSTANCE_LABEL_KEY]: spec.instanceId,
          [APPLICATION_LABEL_KEY]: APPLICATION_LABEL_VALUE,
          [RUNTIME_EPOCH_LABEL_KEY]: String(spec.runtimeEpoch),
          [GENERATION_LABEL_KEY]: String(spec.generation),
        },
        ports: [{ name: "http", port: app.httpPort, targetPort: "http", protocol: "TCP" }],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata(spec, ns, `${name}-network`),
      spec: {
        podSelector: { matchLabels: labels },
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": options.ingressNamespace },
                },
                podSelector: { matchLabels: { "app.kubernetes.io/name": "traefik" } },
              },
            ],
            ports: [{ protocol: "TCP", port: app.httpPort }],
          },
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": options.instanceAccessNamespace },
                },
                podSelector: {
                  matchLabels: { "app.kubernetes.io/name": options.instanceAccessService },
                },
              },
            ],
            ports: [{ protocol: "TCP", port: app.httpPort }],
          },
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": options.controlNamespace },
                },
                podSelector: {
                  matchLabels: { "app.kubernetes.io/name": options.controlService },
                },
              },
            ],
            ports: [{ protocol: "TCP", port: app.httpPort }],
          },
        ],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
                podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
              },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
          {
            to: [
              {
                ipBlock: {
                  cidr: "0.0.0.0/0",
                  except: [
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
                  ],
                },
              },
              {
                ipBlock: {
                  cidr: "::/0",
                  except: [
                    "::/128",
                    "::1/128",
                    "::/96",
                    "::fffe:0:0/95",
                    "2001:db8::/32",
                    "fc00::/7",
                    "fec0::/10",
                    "fe80::/10",
                    "ff00::/8",
                  ],
                },
              },
            ],
            ports: [{ protocol: "TCP", port: 443 }],
          },
        ],
      },
    },
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: metadata(spec, ns, `${name}-quota`),
      spec: {
        hard: {
          pods: "1",
          "requests.cpu": cpu(profile.cpuMilli),
          "requests.memory": memory(profile.memoryMiB),
          "requests.ephemeral-storage": memory(profile.ephemeralStorageMiB),
          ...(spec.scriptoriumAssignment === undefined
            ? {}
            : { "requests.storage": memory(profile.ephemeralStorageMiB) }),
          "limits.cpu": cpu(limits.cpuMilli),
          "limits.memory": memory(limits.memoryMiB),
          "limits.ephemeral-storage": memory(limits.ephemeralStorageMiB),
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: metadata(spec, ns, `${name}-limits`),
      spec: {
        limits: [
          {
            type: "Container",
            max: {
              cpu: cpu(limits.cpuMilli),
              memory: memory(limits.memoryMiB),
              "ephemeral-storage": memory(limits.ephemeralStorageMiB),
            },
            min: {
              cpu: cpu(profile.cpuMilli),
              memory: memory(profile.memoryMiB),
              "ephemeral-storage": memory(profile.ephemeralStorageMiB),
            },
          },
        ],
      },
    },
  ];
}

function endpoint(
  options: KubernetesResourceRendererOptions,
  spec: RunningInstanceSpec | ReleaseSpec,
): KubernetesResource {
  const app = validateApplication(spec.application);
  const ns = namespace(spec, options.namespacePrefix);
  const name = runtimeResourceName(spec.instanceId);
  return {
    apiVersion: "traefik.io/v1alpha1",
    kind: "IngressRoute",
    metadata: metadata(spec, ns, name),
    spec: {
      entryPoints: ["websecure"],
      routes: [
        {
          kind: "Rule",
          match: `Host(\`${validateHostname(spec.hostname)}\`)`,
          priority: 10,
          services: [{ name, port: app.httpPort }],
        },
      ],
      tls: {},
    },
  };
}

function deployment(
  options: KubernetesResourceRendererOptions,
  spec: RuntimeInstanceSpec,
  replicas: 0 | 1,
): KubernetesResource {
  validateArtifact(spec);
  const app = validateApplication(spec.application);
  const ns = namespace(spec, options.namespacePrefix);
  const name = runtimeResourceName(spec.instanceId);
  const profile = spec.resourceProfile.request;
  const limits = options.maximumResources;
  const hostedProjection = runtimeProjection(options, spec);
  const podLabels = {
    ...managedLabels({
      instanceId: spec.instanceId,
      repositoryId: spec.repositoryId,
      runtimeEpoch: spec.runtimeEpoch,
      generation: spec.generation,
      releaseId: spec.release?.releaseId ?? null,
    }),
    [CLUSTER_LABEL_KEY]: spec.clusterId,
    [APPLICATION_LABEL_KEY]: APPLICATION_LABEL_VALUE,
  };
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: metadata(spec, ns, name, true),
    spec: {
      replicas,
      revisionHistoryLimit: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: selector(spec.instanceId) },
      template: {
        metadata: {
          labels: podLabels,
          ...(spec.physicalInstanceId === undefined
            ? {}
            : { annotations: { "praetorium.io/physical-instance-id": spec.physicalInstanceId } }),
        },
        spec: {
          serviceAccountName: `${name}-app`,
          ...(options.includeImagePullSecret === true
            ? { imagePullSecrets: [{ name: `${name}-image-pull` }] }
            : {}),
          automountServiceAccountToken: false,
          // Tenant writers must only run on Agent nodes admitted by the
          // operator's runtime role label. Missing labels leave the writer
          // Pending instead of scheduling it onto the Management Server.
          affinity: {
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                nodeSelectorTerms: [
                  {
                    matchExpressions: [
                      {
                        key: RUNTIME_NODE_ROLE_LABEL_KEY,
                        operator: "In",
                        values: [RUNTIME_NODE_ROLE_LABEL_VALUE],
                      },
                    ],
                  },
                ],
              },
            },
          },
          // Retain the old writer in the API census during a node partition.
          // Default 300-second eviction cannot prove its process has stopped.
          tolerations: [
            { key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute" },
            { key: "node.kubernetes.io/unreachable", operator: "Exists", effect: "NoExecute" },
          ],
          terminationGracePeriodSeconds: app.shutdownTimeoutSeconds,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: SCRIPTORIUM_RUNTIME_UID,
            runAsGroup: SCRIPTORIUM_RUNTIME_GID,
            fsGroup: SCRIPTORIUM_RUNTIME_GID,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "scriptorium",
              image: spec.release?.artifactRef ?? "",
              imagePullPolicy: "IfNotPresent",
              ...(hostedProjection
                ? {
                    env: [
                      { name: "SCRIPTORIUM_HOSTED_MODE", value: "1" },
                      { name: "SCRIPTORIUM_TRUST_PROXY", value: "1" },
                      { name: "SCRIPTORIUM_DATA_DIR", value: "/data/workspace" },
                      { name: "SCRIPTORIUM_USAGE_DIR", value: "/history/private" },
                      {
                        name: "SCRIPTORIUM_RUNTIME_ASSIGNMENT_PATH",
                        value: "/run/scriptorium/runtime-assignment.json",
                      },
                    ],
                  }
                : {}),
              ports: [{ name: "http", containerPort: app.httpPort, protocol: "TCP" }],
              resources: {
                requests: {
                  cpu: cpu(profile.cpuMilli),
                  memory: memory(profile.memoryMiB),
                  "ephemeral-storage": memory(profile.ephemeralStorageMiB),
                },
                limits: {
                  cpu: cpu(options.maximumResources.cpuMilli),
                  memory: memory(options.maximumResources.memoryMiB),
                  "ephemeral-storage": memory(options.maximumResources.ephemeralStorageMiB),
                },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                runAsNonRoot: true,
                seccompProfile: { type: "RuntimeDefault" },
                capabilities: { drop: ["ALL"] },
              },
              startupProbe: {
                httpGet: { path: app.livenessPath, port: "http" },
                periodSeconds: 5,
                timeoutSeconds: 2,
                failureThreshold: 36,
              },
              livenessProbe: {
                httpGet: { path: app.livenessPath, port: "http" },
                periodSeconds: 10,
                timeoutSeconds: 2,
                failureThreshold: 3,
              },
              readinessProbe: {
                httpGet: { path: app.readinessPath, port: "http" },
                periodSeconds: 5,
                timeoutSeconds: 2,
                failureThreshold: 3,
              },
              volumeMounts: [
                { name: "workspace", mountPath: "/data", readOnly: false },
                { name: "temporary", mountPath: "/tmp", readOnly: false },
                ...(hostedProjection
                  ? [{ name: "history", mountPath: "/history", readOnly: false }]
                  : []),
                ...(hostedProjection
                  ? [{ name: "scriptorium-runtime", mountPath: "/run/scriptorium", readOnly: true }]
                  : []),
              ],
            },
          ],
          ...(hostedProjection === null
            ? {}
            : {
                initContainers: [
                  {
                    name: "history-restore",
                    image: spec.release?.artifactRef ?? "",
                    imagePullPolicy: "IfNotPresent",
                    command: ["node", "-e", HISTORY_RESTORE_NODE_SCRIPT],
                    env: [
                      {
                        name: "PRAETORIUM_HISTORY_INSTANCE_ID",
                        value: spec.instanceId,
                      },
                      {
                        name: "PRAETORIUM_HISTORY_REPOSITORY_ID",
                        value: String(spec.repositoryId),
                      },
                      { name: "PRAETORIUM_HISTORY_CLUSTER_ID", value: spec.clusterId },
                      {
                        name: "PRAETORIUM_HISTORY_CLAIM_NAME",
                        value: historyResourceName(spec),
                      },
                    ],
                    resources: {
                      requests: {
                        cpu: cpu(profile.cpuMilli),
                        memory: memory(profile.memoryMiB),
                        "ephemeral-storage": memory(profile.ephemeralStorageMiB),
                      },
                      limits: {
                        cpu: cpu(limits.cpuMilli),
                        memory: memory(limits.memoryMiB),
                        "ephemeral-storage": memory(limits.ephemeralStorageMiB),
                      },
                    },
                    securityContext: {
                      allowPrivilegeEscalation: false,
                      readOnlyRootFilesystem: true,
                      runAsNonRoot: true,
                      runAsUser: SCRIPTORIUM_RUNTIME_UID,
                      runAsGroup: SCRIPTORIUM_RUNTIME_GID,
                      seccompProfile: { type: "RuntimeDefault" },
                      capabilities: { drop: ["ALL"] },
                    },
                    volumeMounts: [
                      { name: "history", mountPath: "/history", readOnly: false },
                      { name: "history-seed", mountPath: "/history-seed", readOnly: true },
                    ],
                  },
                ],
              }),
          volumes: [
            { name: "workspace", emptyDir: { sizeLimit: memory(profile.ephemeralStorageMiB) } },
            { name: "temporary", emptyDir: { sizeLimit: memory(profile.ephemeralStorageMiB) } },
            ...(hostedProjection
              ? [
                  {
                    name: "history",
                    persistentVolumeClaim: {
                      claimName: historyResourceName(spec),
                      readOnly: false,
                    },
                  },
                  {
                    name: "history-seed",
                    secret: { secretName: historySeedName(spec), defaultMode: 0o444 },
                  },
                ]
              : []),
            ...(hostedProjection
              ? [
                  {
                    name: "scriptorium-runtime",
                    secret: { secretName: hostedProjection.secretName, defaultMode: 0o444 },
                  },
                ]
              : []),
          ],
        },
      },
    },
  };
}

export function createKubernetesResourceRenderer(
  options: KubernetesResourceRendererOptions,
): KubernetesResourceRenderer {
  if (options.clusterId.length === 0) failInvalid("runtime cluster id is invalid");
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(options.ingressNamespace)) {
    failInvalid("ingress namespace is invalid");
  }
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(options.instanceAccessNamespace) ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(options.instanceAccessService)
  ) {
    failInvalid("instance access service identity is invalid");
  }
  if (
    options.controlNamespace !== "praetorium-system" ||
    options.controlService !== "provisioner" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(options.controlNamespace) ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(options.controlService)
  ) {
    failInvalid("Provisioner control service identity is invalid");
  }
  return {
    renderRunning(spec: RunningInstanceSpec) {
      const projection = runtimeProjection(options, spec);
      return [
        ...baseResources(options, spec),
        ...(projection === null ? [] : [historyClaim(options, spec)]),
        ...(projection ? [projection.resource] : []),
        deployment(options, spec, 1),
      ];
    },
    renderStopped(spec: StoppedInstanceSpec) {
      if (spec.release === null) return baseResources(options, spec);
      const projection = runtimeProjection(options, spec);
      return [
        ...baseResources(options, spec),
        ...(projection === null ? [] : [historyClaim(options, spec)]),
        ...(projection ? [projection.resource] : []),
        deployment(options, spec, 0),
      ];
    },
    renderRelease(spec: ReleaseSpec) {
      const projection = runtimeProjection(options, spec);
      return [
        ...baseResources(options, spec),
        ...(projection === null ? [] : [historyClaim(options, spec)]),
        ...(projection ? [projection.resource] : []),
        deployment(options, spec, 1),
      ];
    },
    renderEndpoint(spec: RunningInstanceSpec | ReleaseSpec) {
      return endpoint(options, spec);
    },
  };
}
