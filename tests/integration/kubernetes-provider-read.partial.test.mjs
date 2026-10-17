import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const ROOT_ENV = "PRAETORIUM_T07_PROVIDER_READ_OWNER_ROOT";
const CLUSTER_CONFIRM_ENV = "PRAETORIUM_T07_PROVIDER_READ_CONFIRMATION";
const WRITE_CONFIRM_ENV = "PRAETORIUM_T07_PROVIDER_READ_API_WRITE_CONFIRMATION";
const EXPECTED_ROOT = "/tmp/praetorium-owned-kube-fresh-1000-20261017";
const EXPECTED_CLUSTER = "praetorium-owned-kube-fresh-20261017";
const EXPECTED_CONTEXT = `kind-${EXPECTED_CLUSTER}`;
const EXPECTED_CLUSTER_ID = "clu_01M53XVA9C0V0QKDWDSV50WGPD";
const EXPECTED_OWNER = "sophia";
const EXPECTED_UID = 1000;
const EXPECTED_PURPOSE = "fresh canonical product-path Kind create and admission API proof";
const EXPECTED_ARCHIVE =
  "/tmp/praetorium-provider-read-path-artifact-20261017/provisioner-main-431dbe1.oci.tar";
const EXPECTED_ARCHIVE_SHA256 = "5173465b2d29b5d2123a89a696f65b5fb042e6b969f8f50ca82db08808c251a6";
const EXPECTED_MANIFEST = "sha256:00739c31e414da9494015e859b8ef1b0f2289ceef631274a1f953ef70c3e2e64";
const EXPECTED_CONFIG = "sha256:d6e3eeaa4253ea3157a9b25ef944e2a6e6c4c6ae14230809576ccb5b4398120d";
const EXPECTED_IMAGE = "praetorium-owned.local/praetorium/platform-provisioner:main-431dbe1";
const EXPECTED_WRITE_CONFIRMATION =
  "create canonical provisioner bootstrap and one read-path probe Pod in praetorium-system";
const SYSTEM_NAMESPACE = "praetorium-system";
const TEST_TIMEOUT_MS = 420_000;
const PROCESS_TIMEOUT_MS = 30_000;
const RESPONSE_LIMIT_BYTES = 512 * 1024;
const KUBERNETES_UID_PATTERN = /^[0-9a-f-]{36}$/u;

class KubernetesApiStatusError extends Error {
  constructor(statusCode) {
    super(`Kubernetes API returned HTTP ${statusCode}`);
    this.name = "KubernetesApiStatusError";
    this.statusCode = statusCode;
  }
}

class UnreapedProcessGroupError extends Error {
  constructor(cause) {
    super("external command process group did not exit after SIGKILL", { cause });
    this.name = "UnreapedProcessGroupError";
  }
}

const DEFINITIVE_CREATE_REJECTION_STATUSES = new Set([
  400, 401, 403, 404, 405, 409, 410, 413, 415, 422,
]);

function assertExactFile(filePath, expectedMode) {
  return lstat(filePath).then((details) => {
    assert.equal(
      details.isSymbolicLink(),
      false,
      `${path.basename(filePath)} must not be a symlink`,
    );
    assert.equal(details.isFile(), true, `${path.basename(filePath)} must be a regular file`);
    assert.equal(details.uid, EXPECTED_UID, `${path.basename(filePath)} must be owner-private`);
    assert.equal(details.mode & 0o777, expectedMode, `${path.basename(filePath)} has unsafe mode`);
    return details;
  });
}

async function readPrivateJson(filePath) {
  await assertExactFile(filePath, 0o600);
  const bytes = await readFile(filePath);
  assert.ok(
    bytes.length > 0 && bytes.length <= RESPONSE_LIMIT_BYTES,
    "private metadata size is invalid",
  );
  return JSON.parse(bytes.toString("utf8"));
}

function parsePrivateOwner(root, owner, inventory, createResult, confirmation) {
  assert.equal(process.getuid?.(), EXPECTED_UID, "runner must execute as the disposable owner");
  assert.equal(root, EXPECTED_ROOT, "owner root is not the fixed disposable cluster root");
  assert.equal(owner.owner, EXPECTED_OWNER);
  assert.equal(owner.uid, EXPECTED_UID);
  assert.equal(owner.purpose, EXPECTED_PURPOSE);
  assert.equal(owner.clusterName, EXPECTED_CLUSTER);
  assert.equal(owner.clusterId, EXPECTED_CLUSTER_ID);
  const expiry = Date.parse(owner.expiresAt);
  assert.ok(Number.isFinite(expiry) && expiry > Date.now(), "owned cluster has expired");
  assert.ok(expiry <= Date.now() + 24 * 60 * 60 * 1000, "owner expiry exceeds the bounded window");
  assert.equal(
    confirmation,
    owner.clusterName,
    "cluster confirmation must match owner attestation",
  );
  assert.equal(inventory.environment, "disposable-test");
  assert.equal(inventory.clusterId, EXPECTED_CLUSTER_ID);
  assert.deepEqual(inventory.ownership, {
    provider: "kind",
    clusterName: EXPECTED_CLUSTER,
    context: EXPECTED_CONTEXT,
    disposable: true,
    confirmation: EXPECTED_CLUSTER,
  });
  assert.equal(createResult.action, "create");
  assert.equal(createResult.clusterVerified, true);
  assert.equal(createResult.clusterName, EXPECTED_CLUSTER);
  assert.equal(createResult.context, EXPECTED_CONTEXT);
  assert.equal(
    createResult.kubeconfig,
    path.join(root, "t/praetorium-t12-1000/praetorium-owned-kube-fresh-20261017.yaml"),
  );
  assert.deepEqual(inventory.buildPolicy?.runtimeResourceLimits, {
    cpuMilli: 2_000,
    memoryMiB: 4_096,
    ephemeralStorageMiB: 8_192,
  });
  return {
    clusterId: EXPECTED_CLUSTER_ID,
    kubeconfig: createResult.kubeconfig,
    maximumResources: inventory.buildPolicy.runtimeResourceLimits,
  };
}

async function runBounded(command, args, { input, timeoutMs = PROCESS_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: EXPECTED_ROOT,
      env: env ?? {
        PATH: process.env.PATH ?? "/run/current-system/sw/bin",
        HOME: path.join(EXPECTED_ROOT, "home"),
        TMPDIR: path.join(EXPECTED_ROOT, "t"),
        LANG: "C.UTF-8",
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let stopReason;
    let escalationTimer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      if (error) reject(error);
      else resolve(value);
    };
    const signalProcessGroup = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error instanceof Error && error.code === "ESRCH") return;
        try {
          child.kill(signal);
        } catch {
          return;
        }
      }
    };
    const waitForProcessGroupExit = async () => {
      if (!child.pid) return;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          if (error instanceof Error && error.code === "ESRCH") return;
          if (error instanceof Error && error.code !== "EPERM") throw error;
        }
        await delay(25);
      }
      throw new UnreapedProcessGroupError();
    };
    const stop = (reason) => {
      if (stopReason !== undefined) return;
      stopReason = reason;
      signalProcessGroup("SIGTERM");
      escalationTimer = setTimeout(() => signalProcessGroup("SIGKILL"), 2_000);
    };
    const timer = setTimeout(() => stop("bounded external command timed out"), timeoutMs);
    const collect = (target, chunk) => {
      if (stopReason !== undefined) return;
      outputBytes += chunk.length;
      if (outputBytes > RESPONSE_LIMIT_BYTES) {
        stop("external command output exceeded limit");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", () => stop("external command could not start"));
    child.on("close", async (code, signal) => {
      if (stopReason !== undefined) {
        signalProcessGroup("SIGKILL");
        try {
          await waitForProcessGroupExit();
        } catch (error) {
          finish(
            error instanceof UnreapedProcessGroupError
              ? error
              : new UnreapedProcessGroupError(error),
          );
          return;
        }
        finish(new Error(stopReason));
        return;
      }
      if (code !== 0) {
        finish(new Error(`external command failed (${signal ?? code ?? "unknown"})`));
        return;
      }
      finish(undefined, {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

async function loadOwner(root, confirmation) {
  const canonicalRoot = await realpath(root);
  assert.equal(canonicalRoot, EXPECTED_ROOT, "owner root canonical path changed");
  const rootDetails = await lstat(canonicalRoot);
  assert.equal(rootDetails.isSymbolicLink(), false);
  assert.equal(rootDetails.isDirectory(), true);
  assert.equal(rootDetails.uid, EXPECTED_UID);
  assert.equal(rootDetails.mode & 0o777, 0o700);

  const [owner, inventory, createResult] = await Promise.all([
    readPrivateJson(path.join(canonicalRoot, "OWNER.json")),
    readPrivateJson(path.join(canonicalRoot, "owned-inventory.json")),
    readPrivateJson(path.join(canonicalRoot, "proof/create-result.json")),
  ]);
  const config = parsePrivateOwner(canonicalRoot, owner, inventory, createResult, confirmation);
  await assertExactFile(config.kubeconfig, 0o600);
  return { ...config, inventory };
}

async function toolPath(environmentName, fallback) {
  const value = process.env[environmentName] ?? fallback;
  assert.ok(path.isAbsolute(value), `${environmentName} must be an absolute path`);
  const details = await lstat(value);
  assert.equal(details.isSymbolicLink(), false, `${environmentName} must not be a symlink`);
  assert.equal(details.isFile(), true, `${environmentName} must be a regular executable`);
  assert.ok((details.mode & 0o111) !== 0, `${environmentName} must be executable`);
  return value;
}

function assertExpectedKubeconfigSelection(config) {
  assert.equal(config.contexts?.length, 1);
  const selectedContext = config.contexts[0];
  assert.equal(selectedContext.name, EXPECTED_CONTEXT);
  assert.equal(selectedContext.context?.cluster, EXPECTED_CONTEXT);
  assert.equal(config.clusters?.length, 1);
  assert.equal(config.clusters[0].name, selectedContext.context.cluster);
  assert.equal(config.users?.length, 1);
  assert.equal(config.users[0].name, selectedContext.context?.user);
}

async function loadKubeconfig(kubectl, kubeconfig) {
  const { stdout } = await runBounded(kubectl, [
    "--kubeconfig",
    kubeconfig,
    "--context",
    EXPECTED_CONTEXT,
    "config",
    "view",
    "--raw",
    "--minify",
    "-o",
    "json",
  ]);
  const config = JSON.parse(stdout);
  assertExpectedKubeconfigSelection(config);
  const cluster = config.clusters[0].cluster;
  const user = config.users[0].user;
  const server = new URL(cluster.server);
  assert.equal(server.protocol, "https:");
  assert.ok(["127.0.0.1", "::1"].includes(server.hostname));
  assert.ok(!server.username && !server.password && !server.search && !server.hash);
  assert.ok(cluster["certificate-authority-data"]);
  assert.ok(user["client-certificate-data"]);
  assert.ok(user["client-key-data"]);
  assert.equal(user.token, undefined);
  assert.equal(user.exec, undefined);
  return {
    server,
    agent: new https.Agent({
      ca: Buffer.from(cluster["certificate-authority-data"], "base64"),
      cert: Buffer.from(user["client-certificate-data"], "base64"),
      key: Buffer.from(user["client-key-data"], "base64"),
      rejectUnauthorized: true,
      keepAlive: false,
    }),
  };
}

async function apiRequest(client, method, apiPath, body, expectedStatuses = [200]) {
  assert.ok(apiPath.startsWith("/"));
  assert.ok(!apiPath.includes("..") && !apiPath.includes("#"));
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: client.server.protocol,
        hostname: client.server.hostname,
        port: client.server.port,
        method,
        path: apiPath,
        agent: client.agent,
        headers: {
          accept: "application/json",
          ...(encoded === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(encoded.length),
              }),
        },
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > RESPONSE_LIMIT_BYTES) {
            request.destroy(new Error("Kubernetes API response exceeded limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          if (!expectedStatuses.includes(response.statusCode)) {
            reject(new KubernetesApiStatusError(response.statusCode ?? 0));
            return;
          }
          if (responseBody.length === 0) {
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(responseBody));
          } catch {
            reject(new Error("Kubernetes API returned invalid JSON"));
          }
        });
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("Kubernetes API request timed out")));
    request.on("error", () => reject(new Error("Kubernetes API request failed")));
    if (encoded !== undefined) request.write(encoded);
    request.end();
  });
}

async function getOptional(client, apiPath) {
  try {
    return await apiRequest(client, "GET", apiPath);
  } catch (error) {
    if (error instanceof KubernetesApiStatusError && error.statusCode === 404) return undefined;
    throw error;
  }
}

function yamlDocument(source, kind, name) {
  const documents = source
    .split(/^---\s*$/mu)
    .map((document) => document.trim())
    .filter(Boolean);
  const expectedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = documents.filter(
    (document) =>
      new RegExp(`^kind: ${kind}$`, "mu").test(document) &&
      new RegExp(`^metadata:\n  name: ${expectedName}$`, "mu").test(document),
  );
  assert.equal(matches.length, 1, `canonical ${kind}/${name} must have one source document`);
  assert.doesNotMatch(
    matches[0],
    /@@[A-Z0-9_]+@@/u,
    "canonical bootstrap document has placeholders",
  );
  return `${matches[0]}\n`;
}

async function canonicalDoc(repo, relativePath, kind, name) {
  const source = await readFile(path.join(repo, relativePath), "utf8");
  return yamlDocument(source, kind, name);
}

class UncertainCreateOutcomeError extends Error {
  constructor(message) {
    super(message);
    this.name = "UncertainCreateOutcomeError";
  }
}

class RecoveredCreateOutcomeError extends Error {
  constructor(resource) {
    super(`create response was uncertain; recovered the owned ${resource.kind} UID`);
    this.name = "RecoveredCreateOutcomeError";
    this.resource = resource;
  }
}

function resourceCollectionPath(resource) {
  const namespace = encodeURIComponent(resource.metadata.namespace);
  switch (resource.kind) {
    case "Namespace":
      return "/api/v1/namespaces";
    case "ServiceAccount":
      return `/api/v1/namespaces/${namespace}/serviceaccounts`;
    case "ClusterRole":
      return "/apis/rbac.authorization.k8s.io/v1/clusterroles";
    case "ClusterRoleBinding":
      return "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings";
    default:
      throw new Error("unsupported bootstrap resource kind");
  }
}

async function createFromSource(client, kubectl, kubeconfig, yaml, kind, name, runId) {
  const { stdout } = await runBounded(
    kubectl,
    [
      "--kubeconfig",
      kubeconfig,
      "--context",
      EXPECTED_CONTEXT,
      "create",
      "--dry-run=client",
      "--filename",
      "-",
      "--output",
      "json",
    ],
    { input: yaml, timeoutMs: PROCESS_TIMEOUT_MS },
  );
  const resource = JSON.parse(stdout);
  assert.equal(resource.kind, kind);
  assert.equal(resource.metadata?.name, name);
  resource.metadata.labels = {
    ...resource.metadata.labels,
    "praetorium.io/t07-run-id": runId,
  };

  try {
    const created = await apiRequest(client, "POST", resourceCollectionPath(resource), resource, [
      201,
    ]);
    assert.match(created.metadata?.uid ?? "", KUBERNETES_UID_PATTERN);
    assert.equal(created.metadata?.labels?.["praetorium.io/t07-run-id"], runId);
    return created;
  } catch (error) {
    if (
      error instanceof KubernetesApiStatusError &&
      DEFINITIVE_CREATE_REJECTION_STATUSES.has(error.statusCode)
    ) {
      throw error;
    }
    let observed;
    try {
      observed = await getOptional(
        client,
        `${resourceCollectionPath(resource)}/${encodeURIComponent(name)}`,
      );
    } catch {
      throw new UncertainCreateOutcomeError(
        `source create outcome is uncertain for ${kind}/${name}; preserve resources for manual reconciliation`,
      );
    }
    if (
      observed !== undefined &&
      observed.metadata?.labels?.["praetorium.io/t07-run-id"] === runId
    ) {
      if (!KUBERNETES_UID_PATTERN.test(observed.metadata?.uid ?? "")) {
        throw new UncertainCreateOutcomeError(
          `source create outcome is uncertain for ${kind}/${name}; recovered object has no valid UID`,
        );
      }
      throw new RecoveredCreateOutcomeError(observed);
    }
    throw new UncertainCreateOutcomeError(
      `source create outcome is uncertain for ${kind}/${name}; preserve resources for manual reconciliation (${error instanceof Error ? error.message : "request failed"})`,
    );
  }
}

function resourcePath(resource) {
  const name = encodeURIComponent(resource.metadata.name);
  switch (resource.kind) {
    case "Namespace":
      return `/api/v1/namespaces/${name}`;
    case "ServiceAccount":
      return `/api/v1/namespaces/${encodeURIComponent(resource.metadata.namespace)}/serviceaccounts/${name}`;
    case "ClusterRole":
      return `/apis/rbac.authorization.k8s.io/v1/clusterroles/${name}`;
    case "ClusterRoleBinding":
      return `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${name}`;
    case "Pod":
      return `/api/v1/namespaces/${encodeURIComponent(resource.metadata.namespace)}/pods/${name}`;
    default:
      throw new Error("unsupported cleanup resource kind");
  }
}

async function createPod(client, pod) {
  return apiRequest(client, "POST", "/api/v1/namespaces/praetorium-system/pods", pod, [201]);
}

async function waitForPod(client, pathName, uid) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const pod = await apiRequest(client, "GET", pathName);
    assert.equal(pod.metadata?.uid, uid, "probe Pod UID changed while observing it");
    const phase = pod.status?.phase;
    if (phase === "Succeeded" || phase === "Failed") return pod;
    await delay(2_000);
  }
  throw new Error("provider read probe Pod did not finish within 120 seconds");
}

async function readPodLogs(kubectl, kubeconfig, podName) {
  const { stdout } = await runBounded(kubectl, [
    "--kubeconfig",
    kubeconfig,
    "--context",
    EXPECTED_CONTEXT,
    "--request-timeout=10s",
    "logs",
    "--namespace",
    SYSTEM_NAMESPACE,
    podName,
    "--tail=5",
  ]);
  return stdout.trim();
}

async function removeByUid(client, resource, runId) {
  assert.match(
    resource.metadata?.uid ?? "",
    KUBERNETES_UID_PATTERN,
    "cleanup ledger entry has no valid UID; refusing delete",
  );
  const pathname = resourcePath(resource);
  const current = await getOptional(client, pathname);
  if (current === undefined) return;
  assert.match(
    current.metadata?.uid ?? "",
    KUBERNETES_UID_PATTERN,
    "current resource has no valid UID; refusing delete",
  );
  assert.equal(
    current.metadata?.uid,
    resource.metadata.uid,
    "cleanup UID precondition no longer matches",
  );
  assert.equal(
    current.metadata?.labels?.["praetorium.io/t07-run-id"],
    runId,
    "cleanup ownership marker no longer matches",
  );
  await apiRequest(
    client,
    "DELETE",
    pathname,
    {
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid: resource.metadata.uid },
      propagationPolicy: "Foreground",
    },
    [200, 202],
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await getOptional(client, pathname)) === undefined) return;
    await delay(500);
  }
  throw new Error(`UID-preconditioned cleanup did not finish for ${resource.kind}`);
}

async function cleanup(client, created, runId) {
  for (const resource of [...created].reverse()) {
    try {
      await removeByUid(client, resource, runId);
    } catch (error) {
      throw new Error(
        `cleanup stopped at ${resource.kind}; preserve remaining resources for reconciliation: ${error instanceof Error ? error.message : "cleanup failed"}`,
      );
    }
  }
}

function safeRunId() {
  return randomBytes(10).toString("hex");
}

function providerProgram() {
  return String.raw`
import { readFile } from "node:fs/promises";
import { createInClusterKubernetesRuntimeProvider, parseRuntimeInstanceId, parseRuntimeRepositoryId } from "@praetorium/kubernetes";

const marker = "praetorium-t07-provider-read-v1";
try {
  const token = await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8");
  const ca = await readFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt", "utf8");
  if (token.trim().length === 0 || ca.trim().length === 0) throw new Error();
  const clusterId = process.env.PRAETORIUM_T07_CLUSTER_ID;
  const instanceId = parseRuntimeInstanceId(process.env.PRAETORIUM_T07_INSTANCE_ID);
  const repositoryId = parseRuntimeRepositoryId(Number(process.env.PRAETORIUM_T07_REPOSITORY_ID));
  let reservationCalls = 0;
  const provider = createInClusterKubernetesRuntimeProvider({
    namespacePrefix: process.env.PRAETORIUM_T07_NAMESPACE_PREFIX,
    clusterId,
    maxCapacityAgeMs: Number(process.env.PRAETORIUM_T07_MAX_CAPACITY_AGE_MS),
    rendererOptions: {
      ingressNamespace: process.env.PRAETORIUM_T07_INGRESS_NAMESPACE,
      instanceAccessNamespace: process.env.PRAETORIUM_T07_INSTANCE_ACCESS_NAMESPACE,
      instanceAccessService: process.env.PRAETORIUM_T07_INSTANCE_ACCESS_SERVICE,
      controlNamespace: process.env.PRAETORIUM_T07_CONTROL_NAMESPACE,
      controlService: process.env.PRAETORIUM_T07_CONTROL_SERVICE,
      maximumResources: {
        cpuMilli: Number(process.env.PRAETORIUM_T07_MAX_CPU_MILLI),
        memoryMiB: Number(process.env.PRAETORIUM_T07_MAX_MEMORY_MIB),
        ephemeralStorageMiB: Number(process.env.PRAETORIUM_T07_MAX_EPHEMERAL_STORAGE_MIB),
      },
    },
    reservations: {
      currentReservations: async () => { reservationCalls += 1; throw new Error(); },
      recordCapacitySnapshot: async () => { reservationCalls += 1; throw new Error(); },
    },
  });
  const page = await provider.listManagedInstances();
  if (page.items.length !== 0 || page.nextCursor !== undefined) throw new Error();
  const observation = await provider.inspect({
    instanceId,
    repositoryId,
    runtimeEpoch: 1,
    generation: 1,
    clusterId,
  });
  const expectedNamespace = "praetorium-instances-" + instanceId.slice(4).toLowerCase();
  if (
    observation.namespaceExists !== false ||
    observation.state !== "absent" ||
    observation.writerState !== "absent" ||
    observation.writerCensus.complete !== true ||
    observation.writerCensus.scope !== "instance-repository-all-epochs" ||
    observation.writerCensus.queriedNamespace !== expectedNamespace ||
    observation.writerCensus.queriedPodCount !== 0 ||
    observation.writerCensus.pods.length !== 0 ||
    reservationCalls !== 0
  ) throw new Error();
  console.log(JSON.stringify({ marker, status: "passed", tokenProjected: true, managedInstances: 0, inspectedNamespace: "absent", writerCensusComplete: true, reservationCalls }));
} catch {
  console.log(JSON.stringify({ marker, status: "failed", phase: "provider-read" }));
  process.exitCode = 1;
}
`;
}

async function assertNoPreexistingResources(client, identity, podName) {
  const targets = [
    "/api/v1/namespaces/praetorium-system",
    "/api/v1/namespaces/praetorium-system/serviceaccounts/praetorium-provisioner",
    "/apis/rbac.authorization.k8s.io/v1/clusterroles/praetorium-provisioner-bootstrap",
    "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/praetorium-provisioner-bootstrap",
    `/api/v1/namespaces/praetorium-instances-${identity.instanceId.slice(4).toLowerCase()}`,
    `/api/v1/namespaces/praetorium-system/pods/${podName}`,
  ];
  const results = await Promise.all(targets.map((pathname) => getOptional(client, pathname)));
  assert.ok(
    results.every((value) => value === undefined),
    "a canonical or test resource already exists; refusing adoption",
  );
}

async function assertNoManagedDeployments(client, clusterId) {
  const selector = [
    "arcadia.io/platform=arcadia-platform",
    "arcadia.io/ownership-version=v1",
    `arcadia.io/runtime-cluster-id=${clusterId}`,
  ].join(",");
  const result = await apiRequest(
    client,
    "GET",
    `/apis/apps/v1/deployments?labelSelector=${encodeURIComponent(selector)}`,
  );
  assert.deepEqual(result.items, [], "owned cluster already has managed runtime Deployments");
  assert.equal(result.metadata?.continue ?? "", "", "managed Deployment census is incomplete");
}

async function assertOwnedCluster(client, clusterId) {
  const version = await apiRequest(client, "GET", "/version");
  assert.match(version.gitVersion ?? "", /^v1\.35\./u);
  const nodes = await apiRequest(client, "GET", "/api/v1/nodes");
  assert.equal(nodes.items?.length, 1, "expected exactly one node in the owned disposable cluster");
  for (const node of nodes.items) {
    assert.equal(node.metadata?.labels?.["praetorium.io/cluster-id"], clusterId);
    assert.equal(node.metadata?.labels?.["praetorium.io/disposable"], "true");
    assert.ok(
      node.status?.conditions?.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      ),
    );
  }
  return { version: version.gitVersion, nodeCount: nodes.items.length };
}

async function verifyImageArchive() {
  await assertExactFile(EXPECTED_ARCHIVE, 0o600);
  await assertExactFile(
    "/tmp/praetorium-provider-read-path-artifact-20261017/export-report.json",
    0o600,
  );
  const [archive, reportBytes] = await Promise.all([
    readFile(EXPECTED_ARCHIVE),
    readFile("/tmp/praetorium-provider-read-path-artifact-20261017/export-report.json"),
  ]);
  assert.equal(createHash("sha256").update(archive).digest("hex"), EXPECTED_ARCHIVE_SHA256);
  const report = JSON.parse(reportBytes.toString("utf8"));
  assert.equal(report.sourceCommit, "431dbe1c7c86251894efea3de2cf0ec94499ca10");
  assert.equal(report.originalManifestDigest, EXPECTED_MANIFEST);
  assert.equal(report.configDigest, EXPECTED_CONFIG);
  assert.equal(report.archiveSha256, EXPECTED_ARCHIVE_SHA256);
  assert.equal(report.descriptorAndBlobHashesVerified, true);
  assert.equal(report.layerCount, 7);
  assert.equal(report.archiveIndex.mediaType, "application/vnd.oci.image.index.v1+json");
  assert.equal(report.archiveIndex.manifests?.length, 1);
  const descriptor = report.archiveIndex.manifests[0];
  assert.equal(descriptor.mediaType, "application/vnd.docker.distribution.manifest.v2+json");
  assert.equal(descriptor.digest, EXPECTED_MANIFEST);
  assert.deepEqual(descriptor.platform, { os: "linux", architecture: "amd64" });
  assert.equal(descriptor.annotations?.["org.opencontainers.image.ref.name"], EXPECTED_IMAGE);
  return EXPECTED_ARCHIVE;
}

async function productionRuntimeConfig(repo, owner) {
  const services = await readFile(
    path.join(repo, "infrastructure/kubernetes/base/platform-services.yaml"),
    "utf8",
  );
  const getDataValue = (key) => {
    const match = services.match(new RegExp(`^  ${key}: (?:"([^"]*)"|([^\\s]+))$`, "mu"));
    assert.ok(match, `production ConfigMap is missing ${key}`);
    return match[1] ?? match[2];
  };
  const options = {
    namespacePrefix: getDataValue("PROVISIONER_NAMESPACE_PREFIX"),
    clusterId: owner.clusterId,
    maxCapacityAgeMs: Number(getDataValue("PROVISIONER_MAX_CAPACITY_AGE_MS")),
    ingressNamespace: getDataValue("PROVISIONER_INGRESS_NAMESPACE"),
    instanceAccessNamespace: getDataValue("PROVISIONER_INSTANCE_ACCESS_NAMESPACE"),
    instanceAccessService: getDataValue("PROVISIONER_INSTANCE_ACCESS_SERVICE"),
    controlNamespace: getDataValue("PROVISIONER_CONTROL_NAMESPACE"),
    controlService: getDataValue("PROVISIONER_CONTROL_SERVICE"),
    maximumResources: owner.maximumResources,
  };
  assert.deepEqual(options, {
    namespacePrefix: "praetorium-instances",
    clusterId: EXPECTED_CLUSTER_ID,
    maxCapacityAgeMs: 30_000,
    ingressNamespace: "traefik",
    instanceAccessNamespace: "praetorium-system",
    instanceAccessService: "instance-access",
    controlNamespace: "praetorium-system",
    controlService: "provisioner",
    maximumResources: { cpuMilli: 2_000, memoryMiB: 4_096, ephemeralStorageMiB: 8_192 },
  });
  const mainSource = await readFile(path.join(repo, "apps/provisioner/src/main.ts"), "utf8");
  assert.match(mainSource, /namespacePrefix,\s*clusterId,\s*ingressNamespace:/u);
  assert.match(mainSource, /ingressNamespace: required\(env, "PROVISIONER_INGRESS_NAMESPACE"\)/u);
  assert.match(mainSource, /maximumResources: \{/u);
  assert.match(mainSource, /controlNamespace: "praetorium-system"/u);
  assert.match(mainSource, /controlService: "provisioner"/u);
  assert.match(
    mainSource,
    /maxCapacityAgeMs: positiveInteger\(env, "PROVISIONER_MAX_CAPACITY_AGE_MS"\)/u,
  );
  const adapterSource = await readFile(
    path.join(repo, "apps/provisioner/src/kubernetes-lifecycle-adapter.ts"),
    "utf8",
  );
  assert.match(adapterSource, /createInClusterKubernetesRuntimeProvider\(\{/u);
  assert.match(
    adapterSource,
    /currentReservations: \(clusterId\) => capacityReservations\.currentReservations\(clusterId\)/u,
  );
  assert.match(
    adapterSource,
    /recordCapacitySnapshot: \(input\) => capacityReservations\.recordCapacitySnapshot\(input\)/u,
  );
  return options;
}

test("local preflight binds the probe to production provider settings and canonical bootstrap sources", async () => {
  const repo = path.resolve(import.meta.dirname, "../..");
  const owner = {
    clusterId: EXPECTED_CLUSTER_ID,
    maximumResources: { cpuMilli: 2_000, memoryMiB: 4_096, ephemeralStorageMiB: 8_192 },
  };
  assert.equal(
    (await productionRuntimeConfig(repo, owner)).namespacePrefix,
    "praetorium-instances",
  );
  await canonicalDoc(
    repo,
    "infrastructure/kubernetes/base/namespaces.yaml",
    "Namespace",
    SYSTEM_NAMESPACE,
  );
  await canonicalDoc(
    repo,
    "infrastructure/kubernetes/base/platform-services.yaml",
    "ServiceAccount",
    "praetorium-provisioner",
  );
  await canonicalDoc(
    repo,
    "infrastructure/kubernetes/policies/provisioner-rbac.yaml",
    "ClusterRole",
    "praetorium-provisioner-bootstrap",
  );
  await canonicalDoc(
    repo,
    "infrastructure/kubernetes/policies/provisioner-rbac.yaml",
    "ClusterRoleBinding",
    "praetorium-provisioner-bootstrap",
  );
});

test("Kind kubeconfig selection follows the context's cluster and user references", () => {
  const kubeconfigMetadata = {
    contexts: [
      {
        name: EXPECTED_CONTEXT,
        context: { cluster: EXPECTED_CONTEXT, user: EXPECTED_CONTEXT },
      },
    ],
    clusters: [{ name: EXPECTED_CONTEXT }],
    users: [{ name: EXPECTED_CONTEXT }],
  };

  assert.doesNotThrow(() => assertExpectedKubeconfigSelection(kubeconfigMetadata));
  assert.throws(
    () =>
      assertExpectedKubeconfigSelection({
        ...kubeconfigMetadata,
        clusters: [{ name: EXPECTED_CLUSTER }],
      }),
    assert.AssertionError,
    "cluster entry must match the selected context's cluster reference",
  );
  assert.throws(
    () =>
      assertExpectedKubeconfigSelection({
        ...kubeconfigMetadata,
        users: [{ name: "unexpected-user" }],
      }),
    assert.AssertionError,
    "user entry must match the selected context's user reference",
  );
});

test(
  "bounded command timeout kills descendants and waits for process-group exit",
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(path.join(EXPECTED_ROOT, "t/provider-read-runner-"));
    const markerPath = path.join(directory, "late-child-write");
    const childScript = [
      'import { writeFileSync } from "node:fs";',
      'process.on("SIGTERM", () => {});',
      `setTimeout(() => writeFileSync(${JSON.stringify(markerPath)}, "late"), 2_600);`,
    ].join(" ");
    const parentScript = [
      'import { spawn } from "node:child_process";',
      'process.on("SIGTERM", () => {});',
      `spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(childScript)}], { stdio: "inherit" });`,
      "await new Promise(() => {});",
    ].join(" ");
    try {
      const startedAt = Date.now();
      await assert.rejects(
        runBounded(process.execPath, ["--input-type=module", "--eval", parentScript], {
          timeoutMs: 300,
        }),
        /bounded external command timed out/u,
      );
      assert.ok(Date.now() - startedAt >= 1_800, "runner returned before the process group exited");
      await delay(900);
      await assert.rejects(readFile(markerPath), { code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test(
  "bounded timeout kills a TERM-ignoring descendant after its leader closes",
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(path.join(EXPECTED_ROOT, "t/provider-read-leader-exit-"));
    const markerPath = path.join(directory, "late-child-write");
    const childScript = [
      'import { writeFileSync } from "node:fs";',
      'process.on("SIGTERM", () => {});',
      `setTimeout(() => writeFileSync(${JSON.stringify(markerPath)}, "late"), 2_600);`,
    ].join(" ");
    const parentScript = [
      'import { spawn } from "node:child_process";',
      `spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
      "await new Promise(() => {});",
    ].join(" ");
    try {
      await assert.rejects(
        runBounded(process.execPath, ["--input-type=module", "--eval", parentScript], {
          timeoutMs: 300,
        }),
        /bounded external command timed out/u,
      );
      await delay(2_800);
      await assert.rejects(readFile(markerPath), { code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

const armed = Boolean(
  process.env[ROOT_ENV] &&
    process.env[CLUSTER_CONFIRM_ENV] &&
    process.env[WRITE_CONFIRM_ENV] === EXPECTED_WRITE_CONFIRMATION,
);

test(
  "actual Provisioner image reads managed Deployments and a known-absent identity through projected ServiceAccount credentials",
  {
    timeout: TEST_TIMEOUT_MS,
    skip: armed ? false : "BLOCKED: owned-cluster confirmation and API-write handoff are required",
  },
  async () => {
    const root = process.env[ROOT_ENV];
    assert.ok(root, `${ROOT_ENV} is required`);
    assert.equal(process.env[CLUSTER_CONFIRM_ENV], EXPECTED_CLUSTER);
    assert.equal(process.env[WRITE_CONFIRM_ENV], EXPECTED_WRITE_CONFIRMATION);
    const owner = await loadOwner(root, process.env[CLUSTER_CONFIRM_ENV]);
    const repo = path.resolve(import.meta.dirname, "../..");
    const runtimeConfig = await productionRuntimeConfig(repo, owner);
    const kubectl = await toolPath(
      "PRAETORIUM_KUBECTL_BIN",
      "/nix/store/hpxrpfnk0cdij0vwq0djimy9dcjl22vd-kubectl-1.36.1/bin/kubectl",
    );
    const kind = await toolPath(
      "PRAETORIUM_KIND_BIN",
      "/nix/store/vwa0340xq0i90bdjz57zbn22gg17vwc0-kind-0.31.0/bin/kind",
    );
    const [kindVersion, kubectlVersion] = await Promise.all([
      runBounded(kind, ["--version"]),
      runBounded(kubectl, ["version", "--client=true", "-o=json"]),
    ]);
    assert.match(kindVersion.stdout, /^kind version 0\.31\.0\s*$/u);
    assert.equal(JSON.parse(kubectlVersion.stdout).clientVersion?.gitVersion, "v1.36.1");
    const podmanWrapper = path.join(root, "run-private-podman.sh");
    const wrapper = await assertExactFile(podmanWrapper, 0o700);
    assert.equal(wrapper.uid, EXPECTED_UID);
    const client = await loadKubeconfig(kubectl, owner.kubeconfig);
    const clusterProof = await assertOwnedCluster(client, owner.clusterId);
    await assertNoManagedDeployments(client, runtimeConfig.clusterId);

    const runId = safeRunId();
    const instanceId = `ins_${runId.toUpperCase().padEnd(26, "A")}`;
    const identity = { instanceId };
    const podName = `praetorium-provider-read-${runId}`;
    await assertNoPreexistingResources(client, identity, podName);
    const archive = await verifyImageArchive();
    const created = [];
    let imageLoadCompleted = false;
    let preserveResources = false;
    let acceptanceProof;
    let probeFailure;
    let probeFailed = false;
    try {
      const namespaceYaml = await canonicalDoc(
        repo,
        "infrastructure/kubernetes/base/namespaces.yaml",
        "Namespace",
        SYSTEM_NAMESPACE,
      );
      const serviceAccountYaml = await canonicalDoc(
        repo,
        "infrastructure/kubernetes/base/platform-services.yaml",
        "ServiceAccount",
        "praetorium-provisioner",
      );
      const clusterRoleYaml = await canonicalDoc(
        repo,
        "infrastructure/kubernetes/policies/provisioner-rbac.yaml",
        "ClusterRole",
        "praetorium-provisioner-bootstrap",
      );
      const clusterRoleBindingYaml = await canonicalDoc(
        repo,
        "infrastructure/kubernetes/policies/provisioner-rbac.yaml",
        "ClusterRoleBinding",
        "praetorium-provisioner-bootstrap",
      );

      await runBounded(
        podmanWrapper,
        [kind, "load", "image-archive", archive, "--name", EXPECTED_CLUSTER],
        {
          timeoutMs: 180_000,
          env: {
            PATH: "/run/current-system/sw/bin",
            HOME: path.join(root, "home"),
            TMPDIR: path.join(root, "t"),
            LANG: "C.UTF-8",
          },
        },
      );
      imageLoadCompleted = true;

      const namespace = await createFromSource(
        client,
        kubectl,
        owner.kubeconfig,
        namespaceYaml,
        "Namespace",
        SYSTEM_NAMESPACE,
        runId,
      );
      created.push(namespace);
      assert.equal(namespace.metadata.name, SYSTEM_NAMESPACE);
      const serviceAccount = await createFromSource(
        client,
        kubectl,
        owner.kubeconfig,
        serviceAccountYaml,
        "ServiceAccount",
        "praetorium-provisioner",
        runId,
      );
      created.push(serviceAccount);
      assert.equal(serviceAccount.metadata.name, "praetorium-provisioner");
      assert.equal(serviceAccount.metadata.namespace, SYSTEM_NAMESPACE);
      assert.equal(serviceAccount.automountServiceAccountToken, true);
      const role = await createFromSource(
        client,
        kubectl,
        owner.kubeconfig,
        clusterRoleYaml,
        "ClusterRole",
        "praetorium-provisioner-bootstrap",
        runId,
      );
      created.push(role);
      assert.equal(role.metadata.name, "praetorium-provisioner-bootstrap");
      const binding = await createFromSource(
        client,
        kubectl,
        owner.kubeconfig,
        clusterRoleBindingYaml,
        "ClusterRoleBinding",
        "praetorium-provisioner-bootstrap",
        runId,
      );
      created.push(binding);
      assert.equal(binding.metadata.name, "praetorium-provisioner-bootstrap");
      assert.deepEqual(binding.subjects, [
        { kind: "ServiceAccount", name: "praetorium-provisioner", namespace: SYSTEM_NAMESPACE },
      ]);

      const pod = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: podName,
          namespace: SYSTEM_NAMESPACE,
          labels: {
            "app.kubernetes.io/name": "praetorium-provider-read-probe",
            "praetorium.io/t07-run-id": runId,
          },
        },
        spec: {
          serviceAccountName: "praetorium-provisioner",
          automountServiceAccountToken: true,
          restartPolicy: "Never",
          terminationGracePeriodSeconds: 5,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "provider-read",
              image: EXPECTED_IMAGE,
              imagePullPolicy: "Never",
              workingDir: "/app",
              command: ["node", "--input-type=module", "--eval", providerProgram()],
              env: [
                { name: "PRAETORIUM_T07_CLUSTER_ID", value: runtimeConfig.clusterId },
                { name: "PRAETORIUM_T07_INSTANCE_ID", value: instanceId },
                { name: "PRAETORIUM_T07_REPOSITORY_ID", value: "1" },
                { name: "PRAETORIUM_T07_NAMESPACE_PREFIX", value: runtimeConfig.namespacePrefix },
                {
                  name: "PRAETORIUM_T07_MAX_CAPACITY_AGE_MS",
                  value: String(runtimeConfig.maxCapacityAgeMs),
                },
                { name: "PRAETORIUM_T07_INGRESS_NAMESPACE", value: runtimeConfig.ingressNamespace },
                {
                  name: "PRAETORIUM_T07_INSTANCE_ACCESS_NAMESPACE",
                  value: runtimeConfig.instanceAccessNamespace,
                },
                {
                  name: "PRAETORIUM_T07_INSTANCE_ACCESS_SERVICE",
                  value: runtimeConfig.instanceAccessService,
                },
                { name: "PRAETORIUM_T07_CONTROL_NAMESPACE", value: runtimeConfig.controlNamespace },
                { name: "PRAETORIUM_T07_CONTROL_SERVICE", value: runtimeConfig.controlService },
                {
                  name: "PRAETORIUM_T07_MAX_CPU_MILLI",
                  value: String(runtimeConfig.maximumResources.cpuMilli),
                },
                {
                  name: "PRAETORIUM_T07_MAX_MEMORY_MIB",
                  value: String(runtimeConfig.maximumResources.memoryMiB),
                },
                {
                  name: "PRAETORIUM_T07_MAX_EPHEMERAL_STORAGE_MIB",
                  value: String(runtimeConfig.maximumResources.ephemeralStorageMiB),
                },
              ],
              resources: {
                requests: { cpu: "50m", memory: "64Mi", "ephemeral-storage": "64Mi" },
                limits: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "256Mi" },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                runAsNonRoot: true,
                runAsUser: 10001,
                runAsGroup: 10001,
                seccompProfile: { type: "RuntimeDefault" },
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
        },
      };
      let createdPod;
      try {
        createdPod = await createPod(client, pod);
      } catch (error) {
        if (
          error instanceof KubernetesApiStatusError &&
          DEFINITIVE_CREATE_REJECTION_STATUSES.has(error.statusCode)
        ) {
          throw error;
        }
        let observed;
        try {
          observed = await getOptional(client, resourcePath(pod));
        } catch {
          throw new UncertainCreateOutcomeError(
            "probe Pod create result is uncertain; target lookup failed",
          );
        }
        if (observed !== undefined) {
          if (observed.metadata?.labels?.["praetorium.io/t07-run-id"] !== runId) {
            throw new UncertainCreateOutcomeError(
              `probe Pod ${podName} create result is uncertain; existing target is not owned`,
            );
          }
          if (!KUBERNETES_UID_PATTERN.test(observed.metadata?.uid ?? "")) {
            throw new UncertainCreateOutcomeError(
              `probe Pod ${podName} create result is uncertain; marked object has no valid UID`,
            );
          }
          created.push(observed);
          throw new Error(
            `probe Pod ${podName} create response was uncertain; recovered its owned UID and will stop acceptance`,
          );
        }
        throw new UncertainCreateOutcomeError(
          `probe Pod ${podName} create result is uncertain after one 404; preserve resources for manual reconciliation`,
        );
      }
      if (!KUBERNETES_UID_PATTERN.test(createdPod.metadata?.uid ?? "")) {
        throw new UncertainCreateOutcomeError(
          `probe Pod ${podName} create response has no valid UID; preserve resources for reconciliation`,
        );
      }
      created.push(createdPod);
      const podPath = resourcePath(createdPod);
      const finished = await waitForPod(client, podPath, createdPod.metadata.uid);
      assert.equal(
        finished.status.phase,
        "Succeeded",
        "provider image did not complete its read probe",
      );
      const containerStatus = finished.status.containerStatuses?.find(
        (entry) => entry.name === "provider-read",
      );
      assert.equal(containerStatus?.state?.terminated?.exitCode, 0);
      const imageId = containerStatus?.imageID ?? "";
      assert.ok(imageId, "runtime did not report the provider image identity");
      assert.ok(
        [EXPECTED_CONFIG, EXPECTED_MANIFEST].some((digest) => imageId.endsWith(digest)),
        `runtime imageID ${imageId} did not resolve to the preserved image manifest or config digest`,
      );
      const log = await readPodLogs(kubectl, owner.kubeconfig, podName);
      const result = JSON.parse(log);
      assert.deepEqual(result, {
        marker: "praetorium-t07-provider-read-v1",
        status: "passed",
        tokenProjected: true,
        managedInstances: 0,
        inspectedNamespace: "absent",
        writerCensusComplete: true,
        reservationCalls: 0,
      });

      assert.equal(
        await getOptional(
          client,
          `/api/v1/namespaces/praetorium-instances-${instanceId.slice(4).toLowerCase()}`,
        ),
        undefined,
      );
      assert.match(clusterProof.version, /^v1\.35\./u);
      assert.equal(clusterProof.nodeCount, 1);
      acceptanceProof = {
        marker: "praetorium-t07-provider-read-acceptance-v1",
        clusterId: owner.clusterId,
        clusterVersion: clusterProof.version,
        nodeCount: clusterProof.nodeCount,
        sourceCommit: "431dbe1c7c86251894efea3de2cf0ec94499ca10",
        archiveSha256: EXPECTED_ARCHIVE_SHA256,
        manifestDigest: EXPECTED_MANIFEST,
        configDigest: EXPECTED_CONFIG,
        runtimeImageID: imageId,
        managedDeploymentCountBefore: 0,
        probeRunId: runId,
      };
    } catch (error) {
      probeFailed = true;
      if (error instanceof RecoveredCreateOutcomeError) {
        created.push(error.resource);
        probeFailure = new Error(
          `${error.message}; automatic cleanup will use its ownership label and UID`,
          { cause: error },
        );
      } else {
        probeFailure = error;
      }
      if (
        error instanceof UncertainCreateOutcomeError ||
        error instanceof UnreapedProcessGroupError
      ) {
        preserveResources = true;
      }
    }

    if (preserveResources) {
      client.agent.destroy();
      throw new Error(
        "uncertain API or process outcome; automatic cleanup was withheld for reconciliation",
        { cause: probeFailure },
      );
    }
    let cleanupFailure;
    try {
      await cleanup(client, created, runId);
    } catch (error) {
      cleanupFailure = error;
    }
    client.agent.destroy();
    if (probeFailed && cleanupFailure) {
      throw new AggregateError(
        [probeFailure, cleanupFailure],
        "provider read probe and resource cleanup both failed",
      );
    }
    if (cleanupFailure) throw cleanupFailure;
    if (probeFailed) throw probeFailure;

    assert.equal(
      imageLoadCompleted,
      true,
      "exact production image was not loaded into the owned cluster",
    );
    console.log(JSON.stringify({ ...acceptanceProof, resourceCleanup: "complete" }));
  },
);
