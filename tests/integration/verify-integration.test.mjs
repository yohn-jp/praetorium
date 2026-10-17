import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, chown, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import test from "node:test";
import {
  classifyRunnerResult,
  createRunnerEnvironment,
  parseCli,
  REQUIRED_CATEGORIES,
  validateCaFile,
} from "../../scripts/verify-integration.mjs";

const scriptPath = path.resolve("scripts/verify-integration.mjs");
const fixturePath = path.resolve("tests/integration/fixtures/acceptance-inventory.fixture.json");
const sourceHandlersPath = path.resolve("docs/migration/SOURCE-HANDLERS.json");
const coveragePath = path.resolve("docs/migration/COVERAGE.json");

function run(arguments_) {
  const result = spawnSync(process.execPath, [scriptPath, ...arguments_], {
    cwd: path.resolve("."),
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return { ...result, report: JSON.parse(result.stdout) };
}

function validShapeFixture() {
  const ownerIdentity = "t14-fixture-operator@example.invalid";
  return {
    schemaVersion: 1,
    inventoryId: "fixture-only-no-external-resources",
    owner: { name: "T14 fixture operator", identity: ownerIdentity },
    environment: {
      name: "T14 disposable fixture environment",
      purpose: "t14-disposable-test",
      disposable: true,
      production: false,
      expiresAt: "2099-01-01T00:00:00.000Z",
      cleanupProcedure: "No environment exists; fixture is used only for plan tests",
    },
    resources: Object.fromEntries(
      REQUIRED_CATEGORIES.map((id) => [
        id,
        {
          state: "available",
          owner: ownerIdentity,
          disposable: true,
          production: false,
          reference: `fixture-only ${id}`,
        },
      ]),
    ),
  };
}

async function withInventory(inventory, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "praetorium-t14-fixture-"));
  const inventoryPath = path.join(directory, "inventory.fixture.json");
  try {
    await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
    return await callback(inventoryPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("missing inventory is a structured non-success with all proof gates unchecked", () => {
  const result = run(["--plan"]);
  assert.equal(result.status, 2);
  assert.equal(result.report.status, "BLOCKED");
  assert.equal(result.report.effectsExecuted, false);
  assert.deepEqual(
    result.report.categories.map((item) => item.id),
    REQUIRED_CATEGORIES,
  );
  assert.ok(result.report.categories.every((item) => item.status === "NOT_CHECKED"));
  assert.match(result.report.errors[0], /--environment/);
});

test("fixture inventory cannot claim ownership or turn missing categories into proof", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const result = run(["--plan", "--environment", fixturePath]);
  assert.equal(result.status, 2);
  assert.equal(result.report.inventoryId, "fixture-only-not-owned");
  assert.equal(result.report.status, "BLOCKED");
  assert.equal(result.report.effectsExecuted, false);
  assert.ok(result.report.errors.length > 0);
  assert.ok(
    result.report.categories.every(
      (item) => item.status === "BLOCKED" && item.proofStatus === "NOT_CHECKED",
    ),
  );
  assert.equal(Object.keys(fixture.resources).length, REQUIRED_CATEGORIES.length);
});

test("plan is effect-free and reports inventory declarations as unchecked evidence", async () => {
  await withInventory(validShapeFixture(), async (inventoryPath) => {
    const result = run(["--plan", "--environment", inventoryPath]);
    assert.equal(result.status, 0);
    assert.equal(result.report.status, "NOT_CHECKED");
    assert.equal(result.report.effectsExecuted, false);
    assert.deepEqual(
      result.report.intendedEffects.map((item) => item.category),
      REQUIRED_CATEGORIES,
    );
    assert.ok(result.report.categories.every((item) => item.proofStatus === "NOT_CHECKED"));
  });
});

test("missing resource declarations match the strict T12 ownership schema", async () => {
  const inventory = validShapeFixture();
  inventory.resources["workers-d1-do"] = {
    state: "missing",
    owner: inventory.owner.identity,
    disposable: true,
    production: false,
    reference: null,
  };
  await withInventory(inventory, async (inventoryPath) => {
    const result = run(["--plan", "--environment", inventoryPath]);
    assert.equal(result.status, 2);
    assert.equal(result.report.status, "BLOCKED");
    assert.equal(result.report.effectsExecuted, false);
    assert.deepEqual(result.report.errors, []);
    const worker = result.report.categories.find((item) => item.id === "workers-d1-do");
    assert.equal(worker.status, "BLOCKED");
    assert.equal(worker.proofStatus, "NOT_CHECKED");
  });

  inventory.resources["workers-d1-do"] = { state: "missing", reference: null };
  await withInventory(inventory, async (inventoryPath) => {
    const result = run(["--plan", "--environment", inventoryPath]);
    assert.equal(result.status, 2);
    assert.equal(result.report.status, "BLOCKED");
    assert.ok(result.report.errors.includes("workers-d1-do.owner must match owner.identity"));
    assert.ok(result.report.errors.includes("workers-d1-do.disposable must be true"));
    assert.ok(result.report.errors.includes("workers-d1-do.production must be explicitly false"));
  });
});

test("inventory expiry requires an explicit date-time zone", async () => {
  const inventory = validShapeFixture();
  inventory.environment.expiresAt = "2099-01-01T00:00:00";
  await withInventory(inventory, async (inventoryPath) => {
    const result = run(["--plan", "--environment", inventoryPath]);
    assert.equal(result.status, 2);
    assert.equal(result.report.status, "BLOCKED");
    assert.ok(
      result.report.errors.includes(
        "environment.expiresAt must be a future date-time with an explicit zone",
      ),
    );
  });
});

test("unknown inventory fields are rejected before any external effect", async () => {
  const inventory = validShapeFixture();
  const marker = path.join(os.tmpdir(), `praetorium-t14-command-${process.pid}`);
  inventory.resources["workers-d1-do"].command = [
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected")`,
  ];
  await rm(marker, { force: true });
  await withInventory(inventory, async (inventoryPath) => {
    const result = run(["--environment", inventoryPath]);
    assert.equal(result.status, 2);
    assert.equal(result.report.status, "BLOCKED");
    assert.equal(result.report.effectsExecuted, false);
    assert.ok(result.report.errors.some((error) => error.includes("unsupported fields")));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  });
});

test("fixed runners do not inherit ambient credentials or machine configuration", () => {
  const environment = createRunnerEnvironment(
    "/owned-test/inventory.json",
    "github-access",
    "/temporary/isolated-home",
    {
      PATH: "/safe/tools",
      SystemRoot: "C:\\Windows",
      HOME: "/home/operator",
      GITHUB_TOKEN: "production-looking-token",
      KUBECONFIG: "/home/operator/.kube/config",
      AWS_PROFILE: "default",
      NODE_OPTIONS: "--require /tmp/untrusted-preload.cjs",
      NODE_EXTRA_CA_CERTS: "/tmp/ambient-ca.pem",
    },
  );
  assert.deepEqual(environment, {
    PATH: "/safe/tools",
    SystemRoot: "C:\\Windows",
    HOME: "/temporary/isolated-home",
    USERPROFILE: "/temporary/isolated-home",
    XDG_CONFIG_HOME: "/temporary/isolated-home/.config",
    PRAETORIUM_T14_INVENTORY_PATH: "/owned-test/inventory.json",
    PRAETORIUM_T14_CATEGORY: "github-access",
    PRAETORIUM_T14_RESULT_PATH: "/temporary/isolated-home/runner-result.json",
  });
});

test("only an explicitly selected CA is passed to fixed runners", () => {
  const environment = createRunnerEnvironment(
    "/owned-test/inventory.json",
    "buildkit-registry",
    "/temporary/isolated-home",
    {
      PATH: "/safe/tools",
      NODE_OPTIONS: "--require /tmp/untrusted-preload.cjs",
      NODE_EXTRA_CA_CERTS: "/tmp/ambient-ca.pem",
    },
    "/owned-test/registry-ca.pem",
  );
  assert.equal(environment.NODE_EXTRA_CA_CERTS, "/owned-test/registry-ca.pem");
  assert.equal(Object.hasOwn(environment, "NODE_OPTIONS"), false);
  assert.equal(Object.keys(environment).filter((key) => key === "NODE_EXTRA_CA_CERTS").length, 1);
});

test("--ca-file accepts only one absolute owner CA path", () => {
  assert.deepEqual(
    parseCli([
      "--environment",
      "/owned-test/inventory.json",
      "--ca-file",
      "/owned-test/registry-ca.pem",
      "--plan",
    ]),
    {
      inventoryPath: "/owned-test/inventory.json",
      caFile: "/owned-test/registry-ca.pem",
      planOnly: true,
    },
  );
  assert.throws(
    () => parseCli(["--environment", "/owned-test/inventory.json", "--ca-file", "relative.pem"]),
    /absolute path/u,
  );
  assert.throws(
    () =>
      parseCli([
        "--environment",
        "/owned-test/inventory.json",
        "--ca-file",
        "/owned-test/one.pem",
        "--ca-file",
        "/owned-test/two.pem",
      ]),
    /exactly one/u,
  );
});

test("explicit CA input validates PEM certificates and rejects malformed or symlink files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "praetorium-t14-ca-"));
  const caPath = path.join(directory, "ca.pem");
  const malformedPath = path.join(directory, "malformed.pem");
  const symlinkPath = path.join(directory, "symlink.pem");
  try {
    await writeFile(caPath, rootCertificates[0], { mode: 0o600 });
    await assert.doesNotReject(validateCaFile(caPath));
    await chmod(caPath, 0o666);
    await assert.rejects(validateCaFile(caPath), /without group\/world write/u);
    await chmod(caPath, 0o600);

    await writeFile(malformedPath, "not a certificate\n", { mode: 0o600 });
    await assert.rejects(validateCaFile(malformedPath), /valid PEM certificate/u);
    await writeFile(malformedPath, "-----BEGIN PRIVATE KEY-----\nredacted\n", { mode: 0o600 });
    await assert.rejects(validateCaFile(malformedPath), /no private keys/u);
    await writeFile(malformedPath, "a".repeat(256 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(validateCaFile(malformedPath), /bounded regular file/u);

    await symlink(malformedPath, symlinkPath);
    await assert.rejects(validateCaFile(symlinkPath), /must not be a symlink/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("foreign-owned CA files are rejected when the filesystem permits the test", async (t) => {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    t.skip("this platform does not expose UIDs for ownership validation");
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "praetorium-t14-ca-owner-"));
  const caPath = path.join(directory, "ca.pem");
  try {
    await writeFile(caPath, rootCertificates[0], { mode: 0o600 });
    try {
      await chown(caPath, process.getuid() + 1, process.getgid());
    } catch {
      t.skip("the current test user cannot create a foreign-owned file");
      return;
    }
    await assert.rejects(validateCaFile(caPath), /owned by the current UID/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a fixed runner prerequisite report cannot promote a failed or signaled process to proof", () => {
  const report = {
    reportVersion: 1,
    category: "github-access",
    status: "BLOCKED",
    reasonCode: "OWNER_INPUT_MISSING",
  };
  assert.deepEqual(classifyRunnerResult("github-access", { status: 1 }, report), {
    status: "BLOCKED",
    reason: "Required owner input is unavailable",
  });
  assert.equal(classifyRunnerResult("github-access", { status: 1 }).status, "FAILED");
  assert.equal(classifyRunnerResult("github-access", { status: 0 }).status, "VERIFIED");
  assert.equal(classifyRunnerResult("github-access", { status: 0 }, report).status, "FAILED");
  assert.equal(
    classifyRunnerResult("github-access", { status: null, signal: "SIGTERM" }, report).status,
    "FAILED",
  );
  for (const invalid of [
    { ...report, category: "browser-entry" },
    { ...report, status: "VERIFIED" },
    { ...report, reasonCode: "ACCEPTANCE_ASSERTION_FAILED" },
    { ...report, reasonCode: "github_pat_private_value" },
    { ...report, reasonCode: "https://private.invalid/secret" },
    { ...report, reasonCode: "/private/owner/input" },
    { ...report, reasonCode: "OWNER_INPUT_MISSING\u0085" },
    { ...report, reasonCode: "OWNER_INPUT_MISSING\u2028" },
    { ...report, reason: "github_pat_private_value" },
    { ...report, command: "untrusted" },
    {},
  ]) {
    assert.equal(classifyRunnerResult("github-access", { status: 1 }, invalid).status, "FAILED");
  }
});

test("production declarations and incomplete category sets block the run", async () => {
  const inventory = validShapeFixture();
  inventory.resources["github-access"].production = true;
  delete inventory.resources["stable-rollout"];
  await withInventory(inventory, async (inventoryPath) => {
    const result = run(["--plan", "--environment", inventoryPath]);
    assert.equal(result.status, 2);
    assert.equal(result.report.status, "BLOCKED");
    assert.equal(result.report.effectsExecuted, false);
    assert.ok(result.report.errors.some((error) => error.includes("github-access.production")));
    assert.ok(result.report.errors.includes("resources.stable-rollout is required"));
    const stable = result.report.categories.find((item) => item.id === "stable-rollout");
    assert.equal(stable.status, "BLOCKED");
    assert.equal(stable.proofStatus, "NOT_CHECKED");
  });
});

test("expanded source handler surfaces map to current migration coverage", async () => {
  const [inventoryText, coverageText] = await Promise.all([
    readFile(sourceHandlersPath, "utf8"),
    readFile(coveragePath, "utf8"),
  ]);
  const inventory = JSON.parse(inventoryText);
  const coverage = JSON.parse(coverageText);
  const coverageIds = new Set(coverage.entries.map((entry) => entry.id));
  const groupCounts = Object.fromEntries(
    inventory.groups.map((group) => [group.id, group.handlers.length]),
  );
  const handlers = inventory.groups.flatMap((group) => group.handlers);

  assert.equal(handlers.length, 65);
  assert.equal(
    Object.values(inventory.counts).reduce((total, count) => total + count, 0),
    handlers.length,
  );
  assert.deepEqual(groupCounts, {
    gateway: inventory.counts.gatewayRoutes,
    "control-plane": inventory.counts.controlPlaneRoutes,
    "instance-access": inventory.counts.instanceAccessRoutes,
    "provisioner-health": inventory.counts.provisionerHealthRoutes,
    "provisioner-worker": inventory.counts.provisionerWorkerSurfaces,
  });
  for (const handler of handlers) {
    assert.ok(coverageIds.has(handler.coverageEntry), `${handler.surface} has no coverage entry`);
    assert.ok(handler.sourcePath && !path.isAbsolute(handler.sourcePath));
  }
});
