import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  admitServiceInventory,
  archiveServiceSource,
  assertSeparateRegistryCredentials,
  buildctlConnectionArguments,
  prepareServiceImages,
  serviceBuildArguments,
  serviceImages,
  verifiedMain,
  withDeploymentLock,
} from "../../scripts/service-image-publication.mjs";
import { validateInventory } from "../../infrastructure/scripts/inventory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const source = { revision, ciRunId: 42 };

function inventory() {
  const value = JSON.parse(
    readFileSync(path.join(root, "infrastructure/test/disposable-inventory.json")),
  );
  Object.assign(value.domains, {
    gatewayOrigin: "https://gateway.praetorium.example.net",
    gatewayServiceUrl: "https://gateway.praetorium.example.net",
    controlPlaneUrl: "https://control.praetorium.example.net",
  });
  value.network.kubernetesApiEndpoints = [{ address: "10.96.0.1", port: 6443 }];
  Object.assign(value.gateway, {
    allowedRepositoryOwner: "yohn-jp",
    githubAppId: 12345,
    githubOauthClientId: "Iv1.fixture",
    tokenEncryptionKeyId: "initial",
  });
  Object.assign(value.buildkit, {
    endpoint: "tcp://10.20.30.40:1234",
    allowedClientCidrs: ["10.20.30.41/32"],
    frontendRepository: "ghcr.io/praetorium/frontend",
    outputRepository: "ghcr.io/praetorium/output",
  });
  Object.assign(value.buildWorker, {
    signingKeyId: "builder-v1",
    compositionRepository: "praetorium/compositions",
    buildctlPath: "/usr/local/bin/buildctl",
  });
  Object.assign(value.buildPolicy, {
    targetPlatform: "linux/amd64",
    cacheRetention: { maxBytes: 0, maxEntries: 1, minAgeMs: 0, maxEvictions: 1 },
    builderKeys: [
      {
        keyId: "builder-v1",
        publicKeyBase64: Buffer.alloc(32, 1).toString("base64"),
        revoked: false,
        validFrom: null,
        validUntil: null,
      },
    ],
  });
  for (const image of serviceImages.filter(({ key }) => key !== "coordination"))
    value.images[image.key] = `ghcr.io/yohn-jp/praetorium/${image.service}@${digest}`;
  value.images.prometheus = `docker.io/prom/prometheus@${digest}`;
  const checked = validateInventory(value);
  assert.deepEqual(checked.errors, []);
  assert.deepEqual(checked.blockers, []);
  return value;
}

function fixture(t, fault) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "praetorium-publication-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const value = inventory();
  const inventoryPath = path.join(directory, "inventory.json");
  const original = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  writeFileSync(inventoryPath, original, { mode: 0o600 });
  const published = new Set();
  const calls = [];
  const registry = {
    async discoverTag(repository) {
      if (fault === "existing-tag") return { digest };
      if (!published.has(repository))
        throw Object.assign(new Error("not found"), {
          reason: fault === "registry-unavailable" ? "unavailable" : "not_found",
        });
      return { digest: fault === "digest-mismatch" ? `sha256:${"c".repeat(64)}` : digest };
    },
    async verifyImage(repository) {
      if (fault === "registry-denied") throw new Error("registry denied");
      return {
        repository,
        manifestDigest: digest,
        configDigest: digest,
        platform: { os: "linux", architecture: fault === "platform-mismatch" ? "arm64" : "amd64" },
      };
    },
    async readBlob() {
      return {
        bytes: Buffer.from(
          JSON.stringify({
            config: {
              Labels: {
                "org.opencontainers.image.revision":
                  fault === "source-mismatch" ? "c".repeat(40) : revision,
                "org.opencontainers.image.source": "https://github.com/yohn-jp/praetorium",
              },
            },
          }),
        ),
      };
    },
  };
  const prepare = () =>
    prepareServiceImages({
      inventory: value,
      source,
      registry,
      directory,
      build: async ({ service, metadata }) => {
        calls.push(service);
        if (fault === "third-push-denied" && calls.length === 3) throw new Error("push denied");
        if (fault === "timeout") throw new Error("build timeout");
        writeFileSync(
          metadata,
          JSON.stringify({ "containerimage.digest": fault === "bad-metadata" ? "latest" : digest }),
        );
        published.add(`yohn-jp/praetorium/${service}`);
      },
    });
  return { directory, value, inventoryPath, original, calls, prepare };
}

test("four published images and final preflight admit one inventory while retaining exact rollback bytes", async (t) => {
  const f = fixture(t);
  const prepared = await f.prepare();
  assert.deepEqual(
    f.calls,
    serviceImages.map(({ service }) => service),
  );
  assert.deepEqual(readFileSync(f.inventoryPath), f.original);
  let preflights = 0;
  const backup = await admitServiceInventory({
    ...f,
    candidate: prepared.inventory,
    preflight: async (candidate) => {
      preflights++;
      assert.deepEqual(JSON.parse(readFileSync(candidate)), prepared.inventory);
      assert.deepEqual(readFileSync(f.inventoryPath), f.original);
    },
  });
  assert.equal(preflights, 1);
  assert.deepEqual(readFileSync(backup), f.original);
  assert.deepEqual(JSON.parse(readFileSync(f.inventoryPath)), prepared.inventory);
  assert.equal(statSync(f.inventoryPath).mode & 0o777, 0o600);
  assert.equal(prepared.receipt.complete, true);
  assert.equal(Object.keys(prepared.receipt.images).length, 4);
  assert.equal(prepared.inventory.images.prometheus, f.value.images.prometheus);
  assert.ok(prepared.inventory.images.coordination.endsWith(digest));
});

for (const fault of [
  "existing-tag",
  "third-push-denied",
  "timeout",
  "bad-metadata",
  "digest-mismatch",
  "registry-denied",
  "registry-unavailable",
  "platform-mismatch",
  "source-mismatch",
]) {
  test(`${fault} preserves existing inventory and never enters preflight/admission`, async (t) => {
    const f = fixture(t, fault);
    let admitted = false;
    await assert.rejects(async () => {
      const prepared = await f.prepare();
      await admitServiceInventory({
        ...f,
        candidate: prepared.inventory,
        preflight: async () => {
          admitted = true;
        },
      });
    });
    assert.equal(admitted, false);
    assert.deepEqual(readFileSync(f.inventoryPath), f.original);
    assert.deepEqual(
      readdirSync(f.directory).filter(
        (name) => name.includes("before-publication") || name.includes("candidate-"),
      ),
      [],
    );
  });
}

test("failed final production preflight leaves inventory and rollback inputs untouched", async (t) => {
  const f = fixture(t);
  const prepared = await f.prepare();
  await assert.rejects(
    admitServiceInventory({
      ...f,
      candidate: prepared.inventory,
      preflight: async () => {
        throw new Error("D1 unavailable");
      },
    }),
    /D1 unavailable/u,
  );
  assert.deepEqual(readFileSync(f.inventoryPath), f.original);
  assert.deepEqual(
    readdirSync(f.directory).filter(
      (name) => name.includes("before-publication") || name.includes("candidate-"),
    ),
    [],
  );
});

test("concurrent inventory edit is preserved rather than overwritten after preflight", async (t) => {
  const f = fixture(t);
  const prepared = await f.prepare();
  const edit = Buffer.from("owner changed inventory\n");
  await assert.rejects(
    admitServiceInventory({
      ...f,
      candidate: prepared.inventory,
      preflight: async () => writeFileSync(f.inventoryPath, edit),
    }),
    /Inventory changed/u,
  );
  assert.deepEqual(readFileSync(f.inventoryPath), edit);
});

test("verified-main gate rejects stale main, failed/missing CI and unexpected jobs", () => {
  const jobs = [
    "verify",
    "source-stable-fixture",
    "kubernetes-admission",
    ...serviceImages.map(({ service }) => `candidate-images (${service}, package, dockerfile)`),
    "candidate-images (observer, package, dockerfile)",
  ].map((name) => ({ name, conclusion: "success" }));
  const execute = (fault) => (_command, args) => {
    if (args[0] === "rev-parse") return revision;
    if (args[0] === "status") return fault === "dirty" ? " M source.ts" : "";
    if (args[0] === "remote") return "https://github.com/yohn-jp/praetorium.git";
    if (args[0] === "ls-remote")
      return `${fault === "stale" ? "c".repeat(40) : revision}\trefs/heads/main\n`;
    if (args[1].includes("/workflows/"))
      return JSON.stringify({
        workflow_runs:
          (fault === "missing-ci" || (fault === "unreliable-api-filters" && /[?&](?:head_sha|branch|event|status)=/u.test(args[1])))
            ? []
            : [
                {
                  id: 42,
                  head_sha: fault === "wrong-sha" ? "c".repeat(40) : revision,
                  head_branch: fault === "wrong-branch" ? "other" : "main",
                  event: fault === "wrong-event" ? "pull_request" : "push",
                  conclusion: fault === "failed-run" ? "failure" : "success",
                },
              ],
      });
    return JSON.stringify({
      jobs:
        fault === "failed-job"
          ? jobs.map((j, n) => ({ ...j, conclusion: n === 0 ? "failure" : j.conclusion }))
          : fault === "failed-observer"
            ? jobs.map(j => j.name.startsWith("candidate-images (observer,") ? {...j,conclusion:"failure"} : j)
          : fault === "unexpected-job"
            ? [...jobs,{name:"unexpected",conclusion:"success"}]
          : fault === "missing-observer"
            ? jobs.filter(j => !j.name.startsWith("candidate-images (observer,"))
          : fault === "missing-job"
            ? jobs.slice(1)
            : jobs,
    });
  };
  assert.equal(verifiedMain(root, execute()).ciRunId, 42);
  // The live API returned empty conditional listings despite successful runs.
  // Fetch the workflow list and enforce every source/success guard locally.
  assert.equal(verifiedMain(root, execute("unreliable-api-filters")).ciRunId, 42);
  for (const fault of ["dirty", "stale", "missing-ci", "failed-run", "wrong-sha", "wrong-branch", "wrong-event", "failed-job", "missing-job", "failed-observer", "unexpected-job", "missing-observer"])
    assert.throws(() => verifiedMain(root, execute(fault)));
});

test("production build uses the existing pinned recipe, mTLS, provenance and new immutable-source tags", () => {
  const value = inventory();
  const args = serviceBuildArguments({
    inventory: value,
    secrets: {
      buildkitClient: {
        caKey: "/private/ca",
        certKey: "/private/cert",
        privateKey: "/private/key",
      },
    },
    context: "/context",
    metadata: "/metadata",
    ...serviceImages[2],
    tag: `source-${revision}-unique`,
    revision,
  });
  assert.ok(
    args.includes("--tlscacert") && args.includes("--tlscert") && args.includes("--tlskey"),
  );
  assert.ok(args.includes("attest:provenance=mode=max"));
  assert.ok(!args.includes("--attest"));
  assert.ok(args.includes("build-arg:SERVICE_PACKAGE=@praetorium/build-worker"));
  const ci = readFileSync(path.join(root, ".github/workflows/publish-services.yml"), "utf8");
  for (const name of ["NODE_BUILD_IMAGE", "NODE_RUNTIME_IMAGE", "BUILDKIT_CLIENT_IMAGE"]) {
    const pinned = new RegExp(`${name}=([^\\s]+)`, "u").exec(ci)[1];
    assert.ok(args.includes(`build-arg:${name}=${pinned}`));
  }
});

test("Coordination digest is optional and immutable when supplied", () => {
  const value = inventory();
  assert.deepEqual(validateInventory(value).errors, []);
  value.images.coordination = null;
  assert.deepEqual(validateInventory(value).errors, []);
  value.images.coordination = "ghcr.io/yohn-jp/praetorium/coordination:latest";
  assert.ok(validateInventory(value).errors.some((e) => e.includes("images.coordination")));
  value.images.coordination = `ghcr.io/yohn-jp/praetorium/coordination@${digest}`;
  assert.deepEqual(validateInventory(value).errors, []);
});

test("deployment lock excludes another apply through rollout and is released on failure", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    withDeploymentLock(f.inventoryPath, async () => {
      await assert.rejects(
        withDeploymentLock(f.inventoryPath, async () => assert.fail("second deployment entered")),
        /EEXIST/u,
      );
      throw new Error("rollout failed");
    }),
    /rollout failed/u,
  );
  let entered = false;
  await withDeploymentLock(f.inventoryPath, async () => {
    entered = true;
  });
  assert.equal(entered, true);
});

test("a runtime pull credential cannot reuse the publication token even under another username", () => {
  const pull = { username: "reader", password: "disposable-read-token" };
  assert.doesNotThrow(() =>
    assertSeparateRegistryCredentials(pull, {
      username: "reader",
      password: "disposable-write-token",
    }),
  );
  assert.throws(
    () => assertSeparateRegistryCredentials(pull, { ...pull, username: "publisher" }),
    /must be separate/u,
  );
});

test("SSH loopback transport retains Builder TLS identity and never changes the runtime endpoint", () => {
  const value = inventory();
  const original = structuredClone(value);
  const secrets = {
    buildkitClient: { caKey: "/private/ca", certKey: "/private/cert", privateKey: "/private/key" },
  };
  const args = buildctlConnectionArguments({
    inventory: value,
    secrets,
    buildkitAddress: "tcp://127.0.0.1:16445",
  });
  assert.equal(args[args.indexOf("--addr") + 1], "tcp://127.0.0.1:16445");
  assert.equal(args[args.indexOf("--tlsservername") + 1], "10.20.30.40");
  assert.deepEqual(value, original);
  for (const address of [
    "tcp://10.99.0.1:1234",
    "tcp://localhost:1234",
    "tcp://127.0.0.1",
    "tcp://user@127.0.0.1:1234",
    "tcp://127.0.0.1:1234/path",
    "tcp://127.0.0.1:1234?tls=false",
    "http://127.0.0.1:1234",
  ]) {
    assert.throws(() =>
      buildctlConnectionArguments({ inventory: value, secrets, buildkitAddress: address }),
    );
  }
});

test("source archive remains readable by the configured runtime UID under private operator umask", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "praetorium-archive-modes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourceRoot = path.join(directory, "source");
  const context = path.join(directory, "context");
  mkdirSync(sourceRoot);
  mkdirSync(context, { mode: 0o700 });
  mkdirSync(path.join(sourceRoot, "app"));
  writeFileSync(path.join(sourceRoot, "app/package.json"), '{"type":"module"}');
  writeFileSync(path.join(sourceRoot, "app/start"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(sourceRoot, "app/start"), 0o755);
  const git = (...args) => execFileSync("git", args, { cwd: sourceRoot, stdio: "pipe" });
  git("init", "-q");
  git("add", "app");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.net",
    "commit",
    "-qm",
    "fixture",
  );
  const oldMask = process.umask(0o077);
  try {
    archiveServiceSource({
      root: sourceRoot,
      revision: "HEAD",
      archive: path.join(directory, "source.tar"),
      context,
    });
  } finally {
    process.umask(oldMask);
  }
  assert.equal(statSync(path.join(context, "app/package.json")).mode & 0o777, 0o644);
  assert.equal(statSync(path.join(context, "app/start")).mode & 0o777, 0o755);
  assert.equal(statSync(path.join(context, "app")).mode & 0o777, 0o755);
  assert.equal(statSync(context).mode & 0o777, 0o700);
});
