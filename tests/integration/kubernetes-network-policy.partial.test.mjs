import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const INVENTORY_ENV = "PRAETORIUM_T07_PACKET_INVENTORY_PATH";
const REPORT_ENV = "PRAETORIUM_T07_PACKET_REPORT_PATH";
const POD_IMAGE =
  "docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5";
const NODE_IMAGE_DIGEST = POD_IMAGE.slice(POD_IMAGE.lastIndexOf("@") + 1);
const NETWORKPOLICY_VAP = "praetorium-provisioner-tenant-networkpolicy";
const NETWORKPOLICY_BINDING = "praetorium-provisioner-tenant-networkpolicy";
const POD_VAP = "praetorium-tenant-pods-restricted";
const POD_BINDING = "praetorium-tenant-pods-restricted";
const APP_LABEL = "app.kubernetes.io/name";
const INSTANCE_LABEL = "arcadia.io/instance-id";
const RUN_LABEL = "praetorium.io/t07-packet-run";
const INVENTORY_LABEL = "praetorium.io/t07-packet-inventory-id";
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

function exactKeys(value, keys, field) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${field} must be an object`,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${field} has unexpected or missing keys`,
  );
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeAbsolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

function validateInventory(inventory, now = Date.now()) {
  exactKeys(
    inventory,
    [
      "schemaVersion",
      "inventoryId",
      "owner",
      "environment",
      "cluster",
      "tools",
      "image",
      "evidenceDirectory",
      "timeouts",
    ],
    "inventory",
  );
  assert.equal(inventory.schemaVersion, 1);
  assert.match(inventory.inventoryId, /^[a-z0-9][a-z0-9-]{0,62}$/u);

  exactKeys(inventory.owner, ["uid", "username"], "inventory.owner");
  assert.ok(Number.isSafeInteger(inventory.owner.uid) && inventory.owner.uid >= 0);
  assert.ok(nonEmpty(inventory.owner.username));
  assert.equal(
    inventory.owner.uid,
    process.getuid?.(),
    "inventory owner UID must be the current user",
  );
  assert.equal(
    inventory.owner.username,
    os.userInfo().username,
    "inventory owner must be the current user",
  );

  exactKeys(
    inventory.environment,
    ["name", "purpose", "disposable", "production", "expiresAt"],
    "inventory.environment",
  );
  assert.ok(nonEmpty(inventory.environment.name));
  assert.equal(inventory.environment.purpose, "t07-networkpolicy-packets");
  assert.equal(inventory.environment.disposable, true);
  assert.equal(inventory.environment.production, false);
  const expiry = Date.parse(inventory.environment.expiresAt);
  assert.ok(
    Number.isFinite(expiry) && expiry > now,
    "owned environment is expired or has no expiry",
  );

  exactKeys(
    inventory.cluster,
    [
      "provider",
      "name",
      "context",
      "id",
      "apiVersion",
      "nodeName",
      "nodeUid",
      "nodeContainerId",
      "nodeImageRef",
      "nodeImageId",
    ],
    "inventory.cluster",
  );
  assert.equal(inventory.cluster.provider, "kind");
  assert.match(inventory.cluster.name, /^praetorium-owned-kube-[a-z0-9-]+$/u);
  assert.equal(inventory.cluster.context, `kind-${inventory.cluster.name}`);
  assert.match(inventory.cluster.id, /^clu_[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.equal(inventory.cluster.apiVersion, "v1.35.0");
  assert.ok(nonEmpty(inventory.cluster.nodeName));
  assert.match(
    inventory.cluster.nodeUid,
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u,
  );
  assert.match(inventory.cluster.nodeContainerId, /^[a-f0-9]{64}$/u);
  assert.match(inventory.cluster.nodeImageRef, /^kindest\/node:v1\.35\.0@sha256:[a-f0-9]{64}$/u);
  assert.match(inventory.cluster.nodeImageId, /^sha256:[a-f0-9]{64}$/u);

  exactKeys(
    inventory.tools,
    ["kubectlPath", "kindPath", "podmanPath", "kubeconfigPath"],
    "inventory.tools",
  );
  for (const key of ["kubectlPath", "kindPath", "podmanPath", "kubeconfigPath"]) {
    assert.ok(
      safeAbsolutePath(inventory.tools[key]),
      `inventory.tools.${key} must be an absolute path`,
    );
  }

  exactKeys(inventory.image, ["ref", "digest"], "inventory.image");
  assert.equal(
    inventory.image.ref,
    POD_IMAGE,
    "the probe must use the owner-verified immutable Node image",
  );
  assert.equal(inventory.image.digest, NODE_IMAGE_DIGEST);
  assert.ok(safeAbsolutePath(inventory.evidenceDirectory));

  exactKeys(
    inventory.timeouts,
    ["commandMs", "podReadyMs", "probeMs", "convergenceMs", "cleanupMs", "totalMs"],
    "inventory.timeouts",
  );
  for (const [key, min, max] of [
    ["commandMs", 1_000, 30_000],
    ["podReadyMs", 20_000, 180_000],
    ["probeMs", 500, 5_000],
    ["convergenceMs", 5_000, 90_000],
    ["cleanupMs", 20_000, 180_000],
    ["totalMs", 90_000, 600_000],
  ]) {
    assert.ok(
      Number.isSafeInteger(inventory.timeouts[key]) &&
        inventory.timeouts[key] >= min &&
        inventory.timeouts[key] <= max,
      `inventory.timeouts.${key} is outside the bounded range`,
    );
  }
  assert.ok(
    expiry > now + inventory.timeouts.totalMs + inventory.timeouts.cleanupMs + 60_000,
    "owned environment must outlast the bounded run and cleanup window",
  );
}

async function readOwnedInventory(file) {
  assert.ok(safeAbsolutePath(file), `${INVENTORY_ENV} must be an absolute path`);
  const absolute = path.resolve(file);
  const info = await lstat(absolute);
  assert.ok(
    info.isFile() && !info.isSymbolicLink(),
    "owned packet inventory must be a regular file",
  );
  assert.equal(
    info.uid,
    process.getuid?.(),
    "owned packet inventory must belong to the current user",
  );
  assert.equal(info.mode & 0o077, 0, "owned packet inventory must be private to the current user");
  assert.ok(info.size > 0 && info.size <= 32 * 1024, "owned packet inventory size is invalid");
  const inventory = JSON.parse(await readFile(absolute, "utf8"));
  validateInventory(inventory);
  return inventory;
}

async function assertPrivateFile(file, label, { executable = false } = {}) {
  const resolved = await realpath(file);
  const info = await stat(resolved);
  assert.ok(info.isFile(), `${label} must be a regular file`);
  assert.ok(info.size > 0, `${label} must not be empty`);
  assert.equal(info.mode & 0o022, 0, `${label} must not be group/other writable`);
  if (executable) assert.ok(info.mode & 0o111, `${label} must be executable`);
  return resolved;
}

async function run(command, args, { input, timeoutMs, env = process.env } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 2 * 1024 * 1024) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.concat(stderr).length < 256 * 1024) stderr.push(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${path.basename(command)} could not start: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        reject(new Error(`${path.basename(command)} exceeded its ${timeoutMs} ms deadline`));
      } else resolve(result);
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function assertCommandOk(result, label) {
  assert.equal(result.code, 0, `${label} failed (${result.signal ?? `exit ${result.code}`})`);
}

function assertNotFound(result, label) {
  assert.notEqual(result.code, 0, `${label} unexpectedly exists`);
  assert.match(
    result.stderr,
    /(?:NotFound|not found)/iu,
    `${label} lookup failed for a reason other than NotFound`,
  );
}

function jsonOutput(result, label) {
  assertCommandOk(result, label);
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail(`${label} did not return JSON`);
  }
}

function id() {
  return randomBytes(16).toString("hex");
}

function instanceId() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = "ins_";
  for (const byte of randomBytes(26)) value += alphabet[byte & 31];
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sleepPod(name, labels, imageRef, runLabel) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, labels: { ...labels, [RUN_LABEL]: runLabel } },
    spec: {
      automountServiceAccountToken: false,
      terminationGracePeriodSeconds: 1,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 10001,
        runAsGroup: 10001,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "probe",
          image: imageRef,
          imagePullPolicy: "Never",
          command: ["node", "-e", "setInterval(() => {}, 60_000)"],
          readinessProbe: {
            exec: { command: ["node", "-e", "process.exit(0)"] },
            periodSeconds: 2,
            timeoutSeconds: 2,
          },
          resources: {
            requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "128Mi" },
            limits: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "128Mi" },
          },
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            allowPrivilegeEscalation: false,
            privileged: false,
            readOnlyRootFilesystem: true,
            seccompProfile: { type: "RuntimeDefault" },
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
    },
  };
}

function serverPod(name, labels, marker, imageRef, runLabel) {
  const source = [
    "const http = require('node:http');",
    "const marker = process.env.PRAETORIUM_T07_MARKER;",
    "for (const port of [8080, 8081]) {",
    "  http.createServer((req, res) => { res.writeHead(200, {'content-type':'text/plain'}); res.end(marker); }).listen(port, '0.0.0.0');",
    "}",
    "setInterval(() => {}, 60_000);",
  ].join("\n");
  const pod = sleepPod(name, labels, imageRef, runLabel);
  pod.spec.containers[0].command = ["node", "-e", source];
  pod.spec.containers[0].env = [{ name: "PRAETORIUM_T07_MARKER", value: marker }];
  pod.spec.containers[0].ports = [
    { name: "app", containerPort: 8080, protocol: "TCP" },
    { name: "extra", containerPort: 8081, protocol: "TCP" },
  ];
  pod.spec.containers[0].readinessProbe = {
    httpGet: { path: "/", port: 8080 },
    periodSeconds: 2,
    timeoutSeconds: 2,
  };
  return pod;
}

function clientScript(host, port, timeoutMs) {
  const input = JSON.stringify({ host, port, timeoutMs });
  return [
    "const http = require('node:http');",
    `const input = ${input};`,
    "let finished = false;",
    "let timer;",
    "const done = (value) => { if (finished) return; finished = true; clearTimeout(timer); console.log(JSON.stringify(value)); };",
    "const req = http.get({ hostname: input.host, port: input.port, path: '/', timeout: input.timeoutMs, agent: false, headers: { connection: 'close' } }, (res) => {",
    "  let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; });",
    "  res.on('end', () => done({ reachable: true, status: res.statusCode, marker: body }));",
    "});",
    "req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));",
    "req.on('error', (error) => done({ reachable: false, error: error.code || error.name }));",
    `timer = setTimeout(() => { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); }, ${timeoutMs + 250});`,
    "timer.unref();",
  ].join("\n");
}

function dnsScript() {
  return [
    "const dns = require('node:dns').promises;",
    "dns.lookup('kubernetes.default.svc.cluster.local', { family: 4 }).then((record) => {",
    "  console.log(JSON.stringify({ resolved: true, address: record.address }));",
    "}).catch((error) => { console.log(JSON.stringify({ resolved: false, error: error.code || error.name })); });",
  ].join("\n");
}

function ipv4Number(value) {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255))
    return null;
  return parts.reduce((result, part) => (result << 8n) | BigInt(Number(part)), 0n);
}

function isInCidr(ip, cidr) {
  const [network, bitsRaw] = cidr.split("/");
  const ipValue = ipv4Number(ip);
  const networkValue = ipv4Number(network);
  const bits = Number(bitsRaw);
  if (ipValue === null || networkValue === null || !Number.isInteger(bits) || bits < 0 || bits > 32)
    return false;
  const shift = BigInt(32 - bits);
  return ipValue >> shift === networkValue >> shift;
}

function privateExclusions(policy) {
  const peers = policy.spec.egress?.[1]?.to ?? [];
  const ipv4 = peers.find((peer) => peer.ipBlock?.cidr === "0.0.0.0/0")?.ipBlock?.except ?? [];
  return ipv4;
}

function namespacesFor(runId, instance) {
  const suffix = runId.slice(0, 10);
  return {
    tenant: `praetorium-instances-${instance.slice(4).toLowerCase()}`,
    ingress: "traefik",
    other: `praetorium-t07-other-${suffix}`,
    private: `praetorium-t07-private-${suffix}`,
  };
}

const inventoryPath = process.env[INVENTORY_ENV];
test(
  "T07: real packets follow the compiled renderer NetworkPolicy in an owned disposable Kind cluster",
  { skip: !inventoryPath && `${INVENTORY_ENV} is not set`, timeout: 12 * 60_000 },
  async () => {
    const inventory = await readOwnedInventory(inventoryPath);
    const reportPath = process.env[REPORT_ENV];
    assert.ok(safeAbsolutePath(reportPath), `${REPORT_ENV} must name an absolute report path`);
    const reportResolved = path.resolve(reportPath);
    const evidenceDir = await realpath(inventory.evidenceDirectory);
    assert.ok(
      reportResolved.startsWith(`${evidenceDir}${path.sep}`),
      "packet report must be below the owned evidence directory",
    );
    const evidenceInfo = await stat(evidenceDir);
    assert.ok(evidenceInfo.isDirectory() && evidenceInfo.uid === inventory.owner.uid);

    const [kubectlPath, kindPath, podmanPath, kubeconfigPath] = await Promise.all([
      assertPrivateFile(inventory.tools.kubectlPath, "kubectl", { executable: true }),
      assertPrivateFile(inventory.tools.kindPath, "Kind", { executable: true }),
      assertPrivateFile(inventory.tools.podmanPath, "Podman", { executable: true }),
      assertPrivateFile(inventory.tools.kubeconfigPath, "private kubeconfig"),
    ]);
    const kubeconfigInfo = await stat(kubeconfigPath);
    assert.equal(
      kubeconfigInfo.uid,
      inventory.owner.uid,
      "kubeconfig must belong to the current owner",
    );
    assert.equal(kubeconfigInfo.mode & 0o077, 0, "kubeconfig must be private to the current owner");

    const report = {
      schemaVersion: 1,
      scope: "T07 rendered NetworkPolicy real-packet component unit; not full T14 acceptance",
      status: "RUNNING",
      inventoryId: inventory.inventoryId,
      sourceCommit: "unknown",
      runId: id(),
      cluster: {
        name: inventory.cluster.name,
        context: inventory.cluster.context,
        id: inventory.cluster.id,
        nodeName: inventory.cluster.nodeName,
        nodeUid: inventory.cluster.nodeUid,
        nodeContainerId: inventory.cluster.nodeContainerId,
        nodeImageRef: inventory.cluster.nodeImageRef,
        nodeImageId: inventory.cluster.nodeImageId,
      },
      image: { ref: inventory.image.ref, digest: inventory.image.digest, imagePullPolicy: "Never" },
      renderedPolicySha256: null,
      policyUid: null,
      namespaces: [],
      pods: [],
      cases: [],
      metadataEgress:
        "NOT_CHECKED: no explicitly owned metadata canary and positive control were provided",
      publicHttpsEgress:
        "NOT_CHECKED: no owner-controlled public HTTPS marker endpoint was provided",
      cleanup: [],
      cleanupComplete: false,
      startedAt: new Date().toISOString(),
      notes: [
        "Only the actual NetworkPolicy returned by the current TypeScript renderer is created.",
        "No producer image, metadata endpoint, public endpoint, cluster-wide policy, CNI, or product namespace is created or changed.",
      ],
    };
    const startedAt = Date.now();
    const totalDeadline = startedAt + inventory.timeouts.totalMs;
    const actionDeadline = totalDeadline - inventory.timeouts.cleanupMs;
    let cleanupPhase = false;
    let primaryError;
    const ownedNamespaces = [];
    const boundedCommandTimeout = (requested) => {
      const deadline = cleanupPhase ? totalDeadline : actionDeadline;
      const remaining = deadline - Date.now();
      assert.ok(
        remaining > 250,
        `owned packet test exceeded its ${cleanupPhase ? "total" : "resource-action"} deadline`,
      );
      return Math.min(requested, remaining);
    };
    const kubectl = async (args, options = {}) =>
      await run(
        kubectlPath,
        ["--kubeconfig", kubeconfigPath, "--context", inventory.cluster.context, ...args],
        {
          timeoutMs: boundedCommandTimeout(options.timeoutMs ?? inventory.timeouts.commandMs),
          input: options.input,
        },
      );
    const kind = async (args) =>
      await run(kindPath, args, {
        timeoutMs: boundedCommandTimeout(inventory.timeouts.commandMs),
        env: { ...process.env, KIND_EXPERIMENTAL_PROVIDER: "podman" },
      });
    const podman = async (args) =>
      await run(podmanPath, args, {
        timeoutMs: boundedCommandTimeout(inventory.timeouts.commandMs),
      });

    try {
      const sourceHead = await run("git", ["rev-parse", "HEAD"], {
        timeoutMs: inventory.timeouts.commandMs,
      });
      assertCommandOk(sourceHead, "git rev-parse");
      report.sourceCommit = sourceHead.stdout.trim();

      const kindVersion = await kind(["version"]);
      assertCommandOk(kindVersion, "Kind version check");
      assert.ok(
        kindVersion.stdout.includes("kind v0.31.0"),
        "owned Kind version differs from the pinned runtime",
      );
      const kindClusters = await kind(["get", "clusters"]);
      assertCommandOk(kindClusters, "Kind cluster inventory");
      assert.ok(
        kindClusters.stdout.split(/\s+/u).includes(inventory.cluster.name),
        "exact owned Kind cluster is absent",
      );
      const kindNodes = await kind(["get", "nodes", "--name", inventory.cluster.name]);
      assertCommandOk(kindNodes, "Kind node inventory");
      assert.deepEqual(
        kindNodes.stdout.trim().split(/\s+/u),
        [inventory.cluster.nodeName],
        "owned cluster node inventory changed",
      );

      const currentContext = await run(
        kubectlPath,
        ["--kubeconfig", kubeconfigPath, "config", "current-context"],
        { timeoutMs: inventory.timeouts.commandMs },
      );
      assertCommandOk(currentContext, "kubectl current context");
      assert.equal(currentContext.stdout.trim(), inventory.cluster.context);
      const serverVersion = jsonOutput(
        await kubectl([
          "version",
          "-o",
          "json",
          `--request-timeout=${inventory.timeouts.commandMs}ms`,
        ]),
        "Kubernetes server version",
      );
      assert.equal(serverVersion.serverVersion?.gitVersion, inventory.cluster.apiVersion);
      const nodes = jsonOutput(
        await kubectl([
          "get",
          "nodes",
          "-o",
          "json",
          `--request-timeout=${inventory.timeouts.commandMs}ms`,
        ]),
        "Kubernetes node inventory",
      );
      assert.equal(
        nodes.items?.length,
        1,
        "the owned component cluster must have exactly the inventoried single node",
      );
      const node = nodes.items[0];
      assert.equal(node.metadata?.name, inventory.cluster.nodeName);
      assert.equal(node.metadata?.uid, inventory.cluster.nodeUid);
      assert.equal(node.metadata?.labels?.["praetorium.io/disposable"], "true");
      assert.equal(node.status?.nodeInfo?.kubeletVersion, inventory.cluster.apiVersion);
      assert.ok(
        node.status?.conditions?.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        ),
        "owned node is not Ready",
      );

      const nodeContainerOutput = jsonOutput(
        await podman(["inspect", "--format", "{{json .}}", inventory.cluster.nodeName]),
        "Podman Kind node inspection",
      );
      const nodeContainer = Array.isArray(nodeContainerOutput)
        ? nodeContainerOutput[0]
        : nodeContainerOutput;
      assert.equal(
        nodeContainer?.Id,
        inventory.cluster.nodeContainerId,
        "Kind node container identity differs from the owned inventory",
      );
      assert.equal(
        nodeContainer?.Image,
        inventory.cluster.nodeImageId,
        "Kind node container image identity differs from the owned inventory",
      );
      assert.equal(
        nodeContainer?.State?.Status,
        "running",
        "owned Kind node container is not running",
      );
      const nodeImageOutput = jsonOutput(
        await podman(["image", "inspect", "--format", "{{json .}}", inventory.cluster.nodeImageId]),
        "Podman Kind node image inspection",
      );
      const nodeImage = Array.isArray(nodeImageOutput) ? nodeImageOutput[0] : nodeImageOutput;
      const repoDigests = nodeImage?.RepoDigests ?? [];
      const expectedRepoDigest = inventory.cluster.nodeImageRef.replace(":v1.35.0@", "@");
      assert.ok(
        repoDigests.some(
          (digest) => digest === expectedRepoDigest || digest === `docker.io/${expectedRepoDigest}`,
        ),
        "Kind node image digest differs from the owned inventory",
      );

      for (const [kindName, policyName, bindingName] of [
        ["ValidatingAdmissionPolicy", NETWORKPOLICY_VAP, NETWORKPOLICY_BINDING],
        ["ValidatingAdmissionPolicy", POD_VAP, POD_BINDING],
      ]) {
        const policy = jsonOutput(
          await kubectl(["get", kindName, policyName, "-o", "json"]),
          `${policyName} status`,
        );
        const binding = jsonOutput(
          await kubectl(["get", "ValidatingAdmissionPolicyBinding", bindingName, "-o", "json"]),
          `${bindingName} status`,
        );
        assert.ok(
          policy.metadata?.uid && binding.metadata?.uid,
          `${policyName} and binding must exist`,
        );
        assert.equal(
          policy.status?.observedGeneration,
          policy.metadata?.generation,
          `${policyName} status is stale`,
        );
        assert.ok(
          policy.status?.typeChecking && Object.keys(policy.status.typeChecking).length === 0,
          `${policyName} must report current zero-warning type checking`,
        );
        if (policyName === NETWORKPOLICY_VAP) {
          const expressions = (policy.spec?.validations ?? []).map(
            (validation) => validation.expression,
          );
          assert.ok(
            expressions.some((expression) => expression.includes(inventory.cluster.id)),
            "live NetworkPolicy admission policy must be rendered for the exact owned cluster ID",
          );
        }
        assert.equal(binding.spec?.policyName, policyName);
        assert.ok(
          binding.spec?.validationActions?.includes("Deny"),
          `${bindingName} must enforce Deny`,
        );
        report.cases.push({
          name: `${policyName}-current-typecheck-and-deny-binding`,
          passed: true,
          generation: policy.metadata.generation,
          uid: policy.metadata.uid,
          bindingUid: binding.metadata.uid,
        });
      }

      const compiled = await build({
        entryPoints: [
          fileURLToPath(
            new URL("../../plugins/kubernetes/src/kubernetes/renderer.ts", import.meta.url),
          ),
        ],
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        target: "node24",
      });
      const rendererModule = await import(
        `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`
      );
      const applicationOptions = {
        httpPort: 8080,
        livenessPath: "/health/live",
        readinessPath: "/health/ready",
        metadataPath: "/metadata",
        shutdownPath: "/shutdown",
        shutdownTimeoutSeconds: 30,
        platformControlPaths: { status: "/status", quiesce: "/quiesce", resume: "/resume" },
      };
      const currentInstance = instanceId();
      const currentNamespaces = namespacesFor(report.runId, currentInstance);
      for (const name of Object.values(currentNamespaces)) assert.match(name, DNS_LABEL);
      const renderer = rendererModule.createKubernetesResourceRenderer({
        namespacePrefix: "praetorium-instances",
        clusterId: inventory.cluster.id,
        ingressNamespace: currentNamespaces.ingress,
        instanceAccessNamespace: "praetorium-system",
        instanceAccessService: "instance-access",
        controlNamespace: "praetorium-system",
        controlService: "provisioner",
        maximumResources: { cpuMilli: 1000, memoryMiB: 1024, ephemeralStorageMiB: 1024 },
      });
      const renderSpec = {
        instanceId: currentInstance,
        repositoryId: 4815162342,
        runtimeEpoch: 1,
        generation: 1,
        clusterId: inventory.cluster.id,
        release: null,
        resourceProfile: {
          id: "core",
          request: { cpuMilli: 100, memoryMiB: 128, ephemeralStorageMiB: 128 },
        },
        hostname: `probe-${report.runId.slice(0, 12)}.example.test`,
        runtimeConfig: {},
        application: applicationOptions,
      };
      const rendered = renderer.renderStopped(renderSpec);
      const policies = rendered.filter((resource) => resource.kind === "NetworkPolicy");
      assert.equal(policies.length, 1, "renderStopped must yield exactly one NetworkPolicy");
      const policy = structuredClone(policies[0]);
      const instanceNamespace = policy.metadata.namespace;
      assert.equal(
        instanceNamespace,
        currentNamespaces.tenant,
        "renderer namespace must match repository-instance identity",
      );
      report.renderedPolicySha256 = sha256(JSON.stringify(policy));
      const podSelector = policy.spec.podSelector.matchLabels;
      assert.equal(podSelector[INSTANCE_LABEL], currentInstance);
      assert.equal(podSelector[APP_LABEL], "scriptorium");

      const namespaceBase = {
        [RUN_LABEL]: report.runId,
        [INVENTORY_LABEL]: inventory.inventoryId,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      };
      const tenantLabels = {
        ...namespaceBase,
        "arcadia.io/platform": "arcadia-platform",
        "app.kubernetes.io/managed-by": "arcadia-provisioner",
        [INSTANCE_LABEL]: currentInstance,
        "praetorium.io/repository-id": "4815162342",
        "arcadia.io/ownership-version": "v1",
        "arcadia.io/runtime-cluster-id": inventory.cluster.id,
      };
      const peerLabels = { ...namespaceBase };
      const namespaceDefinitions = [
        [currentNamespaces.tenant, tenantLabels],
        [currentNamespaces.ingress, peerLabels],
        [currentNamespaces.other, peerLabels],
        [currentNamespaces.private, peerLabels],
      ];
      for (const [name] of namespaceDefinitions) {
        const exists = await kubectl(["get", "namespace", name, "-o", "json"]);
        if (name === "traefik" && exists.code === 0) {
          const observed = JSON.parse(exists.stdout);
          report.existingCanonicalIngressNamespace = {
            name: observed.metadata?.name,
            uid: observed.metadata?.uid,
            labels: observed.metadata?.labels ?? {},
          };
          throw new Error(
            "canonical traefik namespace already exists; refusing to reuse or mutate a shared namespace",
          );
        }
        assertNotFound(exists, `unique test namespace ${name}`);
      }
      for (const [name, labels] of namespaceDefinitions) {
        const exists = await kubectl(["get", "namespace", name, "-o", "json"]);
        assertNotFound(exists, `unique test namespace ${name}`);
        const namespaceObject = {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name, labels },
        };
        let created;
        try {
          created = jsonOutput(
            await kubectl(["create", "-f", "-", "-o", "json"], {
              input: JSON.stringify(namespaceObject),
            }),
            `create owned namespace ${name}`,
          );
        } catch (error) {
          const maybeCreated = await kubectl(["get", "namespace", name, "-o", "json"]);
          if (maybeCreated.code === 0) {
            const observed = JSON.parse(maybeCreated.stdout);
            if (
              observed.metadata?.labels?.[RUN_LABEL] === report.runId &&
              observed.metadata?.labels?.[INVENTORY_LABEL] === inventory.inventoryId &&
              observed.metadata?.uid
            ) {
              ownedNamespaces.push({ name, uid: observed.metadata.uid });
              report.namespaces.push({
                name,
                uid: observed.metadata.uid,
                role: name === currentNamespaces.tenant ? "tenant" : "probe-peer",
                recoveredAfterCreateError: true,
              });
            }
          }
          throw error;
        }
        assert.ok(created.metadata?.uid, `created namespace ${name} omitted its UID`);
        ownedNamespaces.push({ name, uid: created.metadata.uid });
        report.namespaces.push({
          name,
          uid: created.metadata.uid,
          role: name === currentNamespaces.tenant ? "tenant" : "probe-peer",
        });
      }

      const tenantNamespace = ownedNamespaces.find(
        (namespace) => namespace.name === instanceNamespace,
      );
      assert.ok(tenantNamespace, "tenant namespace ownership record missing");

      const targetMarker = `t07-target-${report.runId}`;
      const privateMarker = `t07-private-${report.runId}`;
      const tenantServer = serverPod(
        "network-target",
        { ...podSelector },
        targetMarker,
        inventory.image.ref,
        report.runId,
      );
      const tenantClient = sleepPod(
        "tenant-client",
        { ...podSelector },
        inventory.image.ref,
        report.runId,
      );
      const allowedPeer = sleepPod(
        "allowed-peer",
        { [APP_LABEL]: "traefik" },
        inventory.image.ref,
        report.runId,
      );
      const wrongLabelPeer = sleepPod(
        "wrong-label-peer",
        { [APP_LABEL]: "not-traefik" },
        inventory.image.ref,
        report.runId,
      );
      const otherNamespacePeer = sleepPod(
        "other-namespace-peer",
        { [APP_LABEL]: "traefik" },
        inventory.image.ref,
        report.runId,
      );
      const privateServer = serverPod(
        "private-target",
        { "app.kubernetes.io/name": "private-target" },
        privateMarker,
        inventory.image.ref,
        report.runId,
      );
      const podSpecs = [
        [instanceNamespace, tenantServer, "tenant-target"],
        [instanceNamespace, tenantClient, "tenant-egress-source"],
        [currentNamespaces.ingress, allowedPeer, "allowed-ingress-peer"],
        [currentNamespaces.ingress, wrongLabelPeer, "wrong-label-peer"],
        [currentNamespaces.other, otherNamespacePeer, "other-namespace-peer"],
        [currentNamespaces.private, privateServer, "private-egress-target"],
      ];
      for (const [namespace, pod, role] of podSpecs) {
        const response = jsonOutput(
          await kubectl(["create", "-f", "-", "-o", "json"], {
            input: JSON.stringify({ ...pod, metadata: { ...pod.metadata, namespace } }),
          }),
          `create ${role}`,
        );
        assert.ok(response.metadata?.uid, `${role} omitted its UID`);
        report.pods.push({
          namespace,
          name: response.metadata.name,
          uid: response.metadata.uid,
          role,
          image: inventory.image.ref,
          imagePullPolicy: "Never",
        });
      }

      for (const [namespace, pod] of podSpecs.map(([namespace, pod]) => [
        namespace,
        pod.metadata.name,
      ])) {
        const waited = await kubectl(
          [
            "wait",
            "--for=condition=Ready",
            "--timeout",
            `${Math.ceil(inventory.timeouts.podReadyMs / 1000)}s`,
            "-n",
            namespace,
            `pod/${pod}`,
          ],
          { timeoutMs: inventory.timeouts.podReadyMs + inventory.timeouts.commandMs },
        );
        assertCommandOk(waited, `wait for Ready pod ${namespace}/${pod}`);
        const observed = jsonOutput(
          await kubectl(["get", "pod", pod, "-n", namespace, "-o", "json"]),
          `observe pod ${namespace}/${pod}`,
        );
        const container = observed.status?.containerStatuses?.find((item) => item.name === "probe");
        assert.equal(observed.status?.phase, "Running", `${namespace}/${pod} is not Running`);
        assert.ok(
          observed.status?.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          ),
          `${namespace}/${pod} is not Ready`,
        );
        assert.equal(observed.spec?.automountServiceAccountToken, false);
        assert.equal(observed.spec?.hostNetwork ?? false, false);
        assert.equal(observed.spec?.hostPID ?? false, false);
        assert.equal(observed.spec?.hostIPC ?? false, false);
        const security = container?.securityContext;
        assert.equal(security?.runAsNonRoot, true);
        assert.equal(security?.runAsUser, 10001);
        assert.equal(security?.allowPrivilegeEscalation, false);
        assert.equal(security?.readOnlyRootFilesystem, true);
        assert.equal(security?.seccompProfile?.type, "RuntimeDefault");
        assert.ok(security?.capabilities?.drop?.includes("ALL"));
        assert.equal(observed.spec?.containers?.length, 1);
        assert.equal(observed.spec.containers[0].image, inventory.image.ref);
        assert.equal(observed.spec.containers[0].imagePullPolicy, "Never");
        assert.equal(
          container?.imageID?.endsWith(`@${inventory.image.digest}`),
          true,
          `${namespace}/${pod} actual imageID did not match the pinned digest`,
        );
        const podRecord = report.pods.find(
          (item) => item.namespace === namespace && item.name === pod,
        );
        podRecord.podIp = observed.status.podIP;
        podRecord.imageId = container.imageID;
      }

      const tenantTarget = report.pods.find((pod) => pod.role === "tenant-target");
      const tenantSource = report.pods.find((pod) => pod.role === "tenant-egress-source");
      const privateTarget = report.pods.find((pod) => pod.role === "private-egress-target");
      const allowedClient = report.pods.find((pod) => pod.role === "allowed-ingress-peer");
      const wrongLabelClient = report.pods.find((pod) => pod.role === "wrong-label-peer");
      const otherNsClient = report.pods.find((pod) => pod.role === "other-namespace-peer");
      assert.ok(tenantTarget.podIp && tenantSource.podIp && privateTarget.podIp);
      assert.ok(
        privateExclusions(policy).some((cidr) => isInCidr(privateTarget.podIp, cidr)),
        `private target ${privateTarget.podIp} is not inside a rendered private IPv4 exclusion`,
      );

      const probe = async (source, target, port) => {
        const script = clientScript(target.podIp, port, inventory.timeouts.probeMs);
        const result = await kubectl(
          ["exec", "-n", source.namespace, source.name, "--", "node", "-e", script],
          { timeoutMs: inventory.timeouts.probeMs + inventory.timeouts.commandMs },
        );
        const parsed = jsonOutput(result, `HTTP probe ${source.role} to ${target.role}:${port}`);
        assert.equal(
          typeof parsed.reachable,
          "boolean",
          "network probe result must expose reachability",
        );
        if (parsed.reachable) {
          assert.equal(
            parsed.status,
            200,
            "network probe target returned an unexpected HTTP status",
          );
          assert.equal(
            parsed.marker,
            target.role === "tenant-target" ? targetMarker : privateMarker,
            "network probe reached the wrong test server",
          );
        }
        return parsed;
      };
      const recordCase = (name, outcome, details = {}) =>
        report.cases.push({ name, passed: outcome, ...details });
      const assertReachable = (result, name) => {
        assert.equal(
          result.reachable,
          true,
          `${name} must be reachable: ${JSON.stringify(result)}`,
        );
        assert.equal(result.status, 200);
      };
      const assertBlocked = (result, name) => {
        assert.equal(result.reachable, false, `${name} unexpectedly reached its destination`);
      };
      const dnsProbe = async () => {
        const result = await kubectl(
          [
            "exec",
            "-n",
            tenantSource.namespace,
            tenantSource.name,
            "--",
            "node",
            "-e",
            dnsScript(),
          ],
          { timeoutMs: inventory.timeouts.probeMs + inventory.timeouts.commandMs },
        );
        return jsonOutput(result, "tenant DNS probe");
      };

      for (const [name, source, target, port] of [
        ["pre-policy-allowed-ingress-peer-port", allowedClient, tenantTarget, 8080],
        ["pre-policy-wrong-label-peer", wrongLabelClient, tenantTarget, 8080],
        ["pre-policy-other-namespace-peer", otherNsClient, tenantTarget, 8080],
        ["pre-policy-tenant-private-egress", tenantSource, privateTarget, 8080],
      ]) {
        const result = await probe(source, target, port);
        assertReachable(result, name);
        recordCase(name, true, {
          port,
          source: source.role,
          destination: target.role,
          observed: result,
        });
      }
      const prePolicyDns = await dnsProbe();
      assert.equal(
        prePolicyDns.resolved,
        true,
        `pre-policy DNS positive control failed: ${JSON.stringify(prePolicyDns)}`,
      );
      recordCase("pre-policy-tenant-dns-positive", true, prePolicyDns);

      policy.metadata.namespace = instanceNamespace;
      const createdPolicy = jsonOutput(
        await kubectl(["create", "-f", "-", "-o", "json"], { input: JSON.stringify(policy) }),
        "create actual rendered tenant NetworkPolicy",
      );
      assert.ok(createdPolicy.metadata?.uid, "created rendered NetworkPolicy omitted its UID");
      report.policyUid = createdPolicy.metadata.uid;
      const persistedPolicy = jsonOutput(
        await kubectl([
          "get",
          "networkpolicy",
          policy.metadata.name,
          "-n",
          instanceNamespace,
          "-o",
          "json",
        ]),
        "observe actual rendered tenant NetworkPolicy",
      );
      assert.equal(persistedPolicy.metadata?.uid, createdPolicy.metadata.uid);
      assert.deepEqual(
        persistedPolicy.spec,
        policy.spec,
        "API server changed the rendered NetworkPolicy spec",
      );

      const deniedCases = [
        ["wrong-namespace-peer-denied", otherNsClient, tenantTarget, 8080],
        ["wrong-pod-label-peer-denied", wrongLabelClient, tenantTarget, 8080],
        ["unlisted-listener-port-denied", allowedClient, tenantTarget, 8081],
        ["private-pod-egress-denied", tenantSource, privateTarget, 8080],
      ];
      const convergenceDeadline = Date.now() + inventory.timeouts.convergenceMs;
      let converged = false;
      const convergenceTrace = [];
      while (Date.now() < Math.min(convergenceDeadline, actionDeadline)) {
        const allowed = await probe(allowedClient, tenantTarget, 8080);
        assertReachable(
          allowed,
          "post-policy allowed ingress peer must remain reachable during convergence",
        );
        const denied = await Promise.all(
          deniedCases.map(([, source, target, port]) => probe(source, target, port)),
        );
        const allDenied = denied.every((result) => result.reachable === false);
        convergenceTrace.push({
          at: new Date().toISOString(),
          allowed: true,
          denied: denied.map((result) => !result.reachable),
        });
        if (allDenied) {
          converged = true;
          break;
        }
        await delay(500);
      }
      assert.equal(
        converged,
        true,
        `NetworkPolicy dataplane did not converge to all deny decisions within ${inventory.timeouts.convergenceMs} ms; trace=${JSON.stringify(convergenceTrace.slice(-5))}`,
      );

      const stableAllowed = await probe(allowedClient, tenantTarget, 8080);
      assertReachable(
        stableAllowed,
        "allowed ingress peer and listener port must work after policy convergence",
      );
      recordCase("allowed-peer-on-rendered-listener-port", true, {
        source: allowedClient.role,
        destination: tenantTarget.role,
        port: 8080,
        observed: stableAllowed,
      });
      for (const [name, source, target, port] of deniedCases) {
        const allowedControl = await probe(allowedClient, tenantTarget, 8080);
        assertReachable(allowedControl, `${name} target liveness positive control`);
        const result = await probe(source, target, port);
        assertBlocked(result, name);
        recordCase(name, true, {
          source: source.role,
          destination: target.role,
          port,
          observed: result,
        });
      }
      const postPolicyDns = await dnsProbe();
      assert.equal(
        postPolicyDns.resolved,
        true,
        `tenant DNS was not allowed by the rendered egress policy: ${JSON.stringify(postPolicyDns)}`,
      );
      recordCase("tenant-dns-allowed-by-rendered-policy", true, postPolicyDns);

      report.status = "PASS";
      report.policyTypecheckEvidence =
        "canonical live VAP objects had observedGeneration=current generation and typeChecking={} before test resources were created";
      report.networkPolicyConvergence = {
        converged: true,
        elapsedMs: inventory.timeouts.convergenceMs - Math.max(0, convergenceDeadline - Date.now()),
        trace: convergenceTrace,
      };
    } catch (error) {
      primaryError = error;
      report.status = "FAIL";
      report.failure = error instanceof Error ? error.message : String(error);
    }

    cleanupPhase = true;
    const cleanupErrors = [];
    for (const namespace of [...ownedNamespaces].reverse()) {
      try {
        const current = await kubectl(["get", "namespace", namespace.name, "-o", "json"]);
        if (current.code !== 0) {
          assertNotFound(current, `cleanup namespace ${namespace.name}`);
          report.cleanup.push({
            name: namespace.name,
            uid: namespace.uid,
            result: "already-absent",
          });
          continue;
        }
        const observed = JSON.parse(current.stdout);
        if (observed.metadata?.uid !== namespace.uid) {
          throw new Error(`refusing to delete namespace ${namespace.name}: UID changed`);
        }
        const deleted = await kubectl([
          "delete",
          "namespace",
          namespace.name,
          `--preconditions=uid=${namespace.uid}`,
          "--wait=false",
        ]);
        assertCommandOk(deleted, `UID-preconditioned delete namespace ${namespace.name}`);
        const deadline = Math.min(Date.now() + inventory.timeouts.cleanupMs, totalDeadline);
        let absent = false;
        while (Date.now() < deadline) {
          const state = await kubectl(["get", "namespace", namespace.name, "-o", "json"]);
          if (state.code !== 0) {
            assertNotFound(state, `verify cleanup namespace ${namespace.name}`);
            absent = true;
            break;
          }
          const latest = JSON.parse(state.stdout);
          assert.equal(
            latest.metadata?.uid,
            namespace.uid,
            `namespace ${namespace.name} UID changed during cleanup`,
          );
          await delay(500);
        }
        assert.equal(
          absent,
          true,
          `namespace ${namespace.name} remains after UID-preconditioned cleanup`,
        );
        report.cleanup.push({
          name: namespace.name,
          uid: namespace.uid,
          result: "uid-preconditioned-delete-and-absence-verified",
        });
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
        report.cleanup.push({
          name: namespace.name,
          uid: namespace.uid,
          result: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    report.cleanupComplete =
      cleanupErrors.length === 0 && report.cleanup.length === ownedNamespaces.length;
    report.cleanupErrors = cleanupErrors;
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    if (cleanupErrors.length > 0) {
      report.status = "FAIL";
      report.failure = [report.failure, ...cleanupErrors].filter(Boolean).join("; ");
    }

    const reportDir = path.dirname(path.resolve(reportPath));
    const dirInfo = await stat(reportDir);
    assert.equal(
      dirInfo.uid,
      inventory.owner.uid,
      "report directory must belong to the current owner",
    );
    assert.ok(dirInfo.isDirectory());
    await mkdir(reportDir, { recursive: false }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    if (primaryError) throw primaryError;
    assert.deepEqual(
      cleanupErrors,
      [],
      "owned packet test cleanup must complete without force deletion",
    );
    assert.equal(report.status, "PASS");
  },
);
