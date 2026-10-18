#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const revision = "008d5c429ec279a424cafd5b8c4cbee70a613b8e";
const sourceOrigin = "https://github.com/yohn-jp/scriptorium";
const imageRepository = "127.0.0.1:5000/scriptorium/producer";
const recipientFingerprint = "4f117e60f1ff8af66e5eb9619dcf7142782162507ec558201b77d4ac62c2ad9b";
const cosignIdentity =
  "https://github.com/yohn-jp/praetorium/.github/workflows/scriptorium-producer-verification.yml@refs/heads/main";
const cosignIssuer = "https://token.actions.githubusercontent.com";
const sourceRoots = ["app", "packages", "modules", "profiles", "scripts", "buildkit"];
const sourceFilesAtRoot = ["LICENSE", "package.json", "pnpm-workspace.yaml", "tsconfig.base.json"];
const recipeFiles = [
  "Dockerfile",
  "package.json",
  "pnpm-workspace.yaml",
  "scripts/profile-build.mjs",
  "scripts/profile-package.mjs",
  "scripts/hosted-build.mjs",
  "scripts/composition-persistence.mjs",
  "scripts/hosted-smoke.mjs",
  "scripts/runtime-package-closure.mjs",
  "app/vite.config.ts",
  "packages/module-runtime/src/module-plan.ts",
  "packages/module-runtime/src/build-catalog.ts",
  "packages/module-runtime/src/persistence-formats.ts",
  "buildkit/frontend/main.go",
  "buildkit/frontend/go.mod",
  "buildkit/frontend/go.sum",
];
const moduleIds = [
  "assistant",
  "diagnostics",
  "mcp",
  "nlp",
  "publishing",
  "semantic",
  "speaker",
  "story",
];
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const hexPattern = /^[a-f0-9]{64}$/u;
const maxJsonBytes = 16 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unexpected or missing fields`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value))
    fail(`${label} is not a SHA-256 digest`);
}

function git(args, sourceRoot) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: sourceRoot,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`git ${args[0]} failed in the pinned source checkout`);
  return result.stdout.trim();
}

async function walkFiles(directory, relativeDirectory, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    if (
      ["node_modules", "dist", "generated", ".git", "coverage", "build", ".turbo"].includes(
        entry.name,
      )
    )
      continue;
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) fail(`Pinned source contains an untrusted symlink: ${relative}`);
    if (info.isDirectory()) await walkFiles(absolute, relative, output);
    else if (info.isFile() && !entry.name.endsWith(".tsbuildinfo"))
      output.push({ absolute, relative });
  }
}

async function sourceInventory(sourceRoot) {
  const files = [];
  for (const name of sourceFilesAtRoot) {
    const absolute = path.join(sourceRoot, name);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) fail(`Invalid pinned source input: ${name}`);
      files.push({ absolute, relative: name });
    } catch (error) {
      if (error?.code !== "ENOENT" || !["LICENSE"].includes(name)) throw error;
    }
  }
  for (const name of sourceRoots) {
    const absolute = path.join(sourceRoot, name);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isDirectory())
        fail(`Invalid pinned source directory: ${name}`);
      await walkFiles(absolute, name, files);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  files.sort((left, right) =>
    left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0,
  );
  return files;
}

async function calculateSourceDigests(sourceRoot) {
  const inventory = await sourceInventory(sourceRoot);
  const inventoryEntries = await Promise.all(
    inventory.map(async ({ absolute, relative }) => ({
      path: relative,
      sha256: createHash("sha256")
        .update(await readFile(absolute))
        .digest("hex"),
    })),
  );
  const sourceDigest = sha256(Buffer.from(canonicalJson(inventoryEntries), "utf8"));
  const recipeEntries = await Promise.all(
    recipeFiles.map(async (relative) => {
      const absolute = path.join(sourceRoot, relative);
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink())
        fail(`Invalid producer recipe input: ${relative}`);
      return {
        path: relative,
        sha256: createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex"),
      };
    }),
  );
  recipeEntries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const recipeDigest = sha256(Buffer.from(canonicalJson(recipeEntries), "utf8"));
  const lockDigest = sha256(await readFile(path.join(sourceRoot, "pnpm-lock.yaml")));
  return { sourceDigest, recipeDigest, lockDigest };
}

async function readJson(directory, name, { canonical = false, maxBytes = maxJsonBytes } = {}) {
  const filename = path.join(directory, name);
  const bytes = await readFile(filename);
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) fail(`${name} has an invalid size`);
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail(`${name} is not valid UTF-8 JSON`);
  }
  if (canonical && canonicalJson(value) !== text) fail(`${name} is not canonical JSON`);
  return { value, bytes, text };
}

function validResourceAmounts(value, label) {
  exactKeys(value, ["cpuMilli", "memoryMiB", "ephemeralStorageMiB"], label);
  for (const amount of Object.values(value)) {
    if (!Number.isSafeInteger(amount) || amount < 0) fail(`${label} contains an invalid amount`);
  }
}

function validateCatalog(catalog, sourceDigests, buildReport) {
  exactKeys(
    catalog,
    [
      "contractVersion",
      "producerRevision",
      "runtimeBaseDigest",
      "buildKitDigest",
      "recipeDigest",
      "lockDigest",
      "sourceDigest",
      "supportedPlatforms",
      "modules",
      "baseResources",
      "sharedResourceGroups",
      "resourceProfiles",
    ],
    "build catalog",
  );
  if (catalog.contractVersion !== "scriptorium-build/v1" || catalog.producerRevision !== revision) {
    fail("build catalog contract or producer revision is incorrect");
  }
  for (const key of [
    "runtimeBaseDigest",
    "buildKitDigest",
    "recipeDigest",
    "lockDigest",
    "sourceDigest",
  ]) {
    requireDigest(catalog[key], `catalog ${key}`);
  }
  for (const key of ["sourceDigest", "recipeDigest", "lockDigest"]) {
    if (catalog[key] !== sourceDigests[key])
      fail(`catalog ${key} does not match the exact pinned source`);
  }
  if (
    catalog.runtimeBaseDigest !== buildReport.images["runtime-base"].digest ||
    catalog.buildKitDigest !== buildReport.images["build-kit"].digest
  ) {
    fail("catalog image digests do not match the build report");
  }
  if (canonicalJson(catalog.supportedPlatforms) !== '["linux/amd64"]')
    fail("catalog platform is unsupported");
  if (
    !Array.isArray(catalog.modules) ||
    catalog.modules.length !== moduleIds.length ||
    canonicalJson(catalog.modules.map((item) => item?.id)) !== canonicalJson(moduleIds)
  ) {
    fail("catalog module set or order does not match the pinned producer contract");
  }
  for (const module of catalog.modules) {
    exactKeys(
      module,
      [
        "id",
        "version",
        "artifactDigest",
        "requires",
        "conflicts",
        "contractRange",
        "exclusiveResources",
        "sharedResourceGroupIds",
        "workerLimits",
      ],
      `catalog module ${module?.id ?? "unknown"}`,
    );
    if (
      typeof module.id !== "string" ||
      !moduleIds.includes(module.id) ||
      typeof module.version !== "string" ||
      module.version.length === 0 ||
      module.version.length > 512
    ) {
      fail("catalog module identity is invalid");
    }
    requireDigest(module.artifactDigest, `catalog module ${module.id} artifactDigest`);
    if (
      !Array.isArray(module.requires) ||
      module.requires.some((id) => typeof id !== "string") ||
      !Array.isArray(module.conflicts) ||
      module.conflicts.some((id) => typeof id !== "string") ||
      !Array.isArray(module.sharedResourceGroupIds) ||
      module.sharedResourceGroupIds.some((id) => typeof id !== "string") ||
      !isRecord(module.workerLimits) ||
      Object.values(module.workerLimits).some((limit) => !Number.isSafeInteger(limit) || limit < 0)
    ) {
      fail(`catalog module ${module.id} descriptor is invalid`);
    }
    validResourceAmounts(module.exclusiveResources, `catalog module ${module.id} resources`);
  }
  validResourceAmounts(catalog.baseResources, "catalog base resources");
  if (
    !Array.isArray(catalog.sharedResourceGroups) ||
    catalog.sharedResourceGroups.length !== 2 ||
    canonicalJson(catalog.sharedResourceGroups.map(({ id }) => id)) !==
      '["worker-runtime","semantic-models"]'
  ) {
    fail("catalog shared resource groups are invalid");
  }
  for (const group of catalog.sharedResourceGroups) {
    exactKeys(group, ["id", "resources"], "catalog shared resource group");
    validResourceAmounts(group.resources, `catalog shared resources ${group.id}`);
  }
  if (
    !Array.isArray(catalog.resourceProfiles) ||
    catalog.resourceProfiles.length !== 3 ||
    canonicalJson(catalog.resourceProfiles.map(({ id }) => id)) !== '["small","balanced","large"]'
  ) {
    fail("catalog resource profiles are invalid");
  }
  for (const profile of catalog.resourceProfiles) {
    exactKeys(
      profile,
      ["id", "cpuMilli", "memoryMiB", "ephemeralStorageMiB"],
      "catalog resource profile",
    );
    validResourceAmounts(
      {
        cpuMilli: profile.cpuMilli,
        memoryMiB: profile.memoryMiB,
        ephemeralStorageMiB: profile.ephemeralStorageMiB,
      },
      `catalog profile ${profile.id}`,
    );
  }
}

function validateRuntimeMetadata(runtimeMetadata) {
  const expected = {
    contractVersion: "scriptorium-platform/v1",
    producerRevision: revision,
    listener: { port: 3000 },
    paths: {
      liveness: "/health/live",
      readiness: "/health/ready",
      metadata: "/api/platform/v1/metadata",
      shutdown: "/api/platform/v1/quiesce",
      status: "/api/platform/v1/status",
      quiesce: "/api/platform/v1/quiesce",
      resume: "/api/platform/v1/resume",
    },
    shutdownTimeoutSeconds: 25,
  };
  if (canonicalJson(runtimeMetadata) !== canonicalJson(expected)) {
    fail("runtime metadata does not match the pinned platform contract");
  }
}

function validateImageMetadata(metadata, name, reportEntry) {
  if (!isRecord(metadata)) fail(`${name} BuildKit metadata is invalid`);
  const digest = metadata["containerimage.digest"];
  requireDigest(digest, `${name} BuildKit digest`);
  if (
    metadata["containerimage.descriptor"]?.digest !== digest ||
    reportEntry.digest !== digest ||
    reportEntry.reference !== `${imageRepository}@${digest}`
  ) {
    fail(`${name} digest does not match the report's immutable image reference`);
  }
  const expectedArchive = {
    "runtime-base": "runtime-base.oci.tar",
    "build-kit": "build-kit.oci.tar",
    "composition-core": "composition-core.oci.tar",
    "composition-story": "composition-story.oci.tar",
  }[name];
  if (
    reportEntry.archive !== expectedArchive ||
    !Number.isSafeInteger(reportEntry.archiveSizeBytes) ||
    reportEntry.archiveSizeBytes <= 0
  ) {
    fail(`${name} OCI archive evidence is invalid`);
  }
}

function validateBuildReport(report, metadata) {
  exactKeys(
    report,
    [
      "schemaVersion",
      "producerRevision",
      "sourceOrigin",
      "dockerfileSha256",
      "sourceDigest",
      "recipeDigest",
      "lockDigest",
      "cosignIdentity",
      "cosignIssuer",
      "recipientCertificateFingerprintSha256",
      "imageRepository",
      "images",
      "catalogSha256",
      "runtimeMetadataSha256",
      "statementSha256",
      "encryptedEvidence",
      "registryPublication",
      "artifactPublication",
    ],
    "build report",
  );
  if (
    report.schemaVersion !== "praetorium-scriptorium-producer-verification/v1" ||
    report.producerRevision !== revision ||
    report.sourceOrigin !== sourceOrigin ||
    report.imageRepository !== imageRepository ||
    report.cosignIdentity !== cosignIdentity ||
    report.cosignIssuer !== cosignIssuer ||
    report.recipientCertificateFingerprintSha256 !== recipientFingerprint ||
    report.registryPublication !== "loopback disposable registry only" ||
    report.artifactPublication !== "ciphertext-only one-day GitHub Actions artifact"
  ) {
    fail("build report identity or publication boundary is invalid");
  }
  if (
    typeof report.dockerfileSha256 !== "string" ||
    !hexPattern.test(report.dockerfileSha256) ||
    report.dockerfileSha256 !== createHash("sha256").update(metadata.dockerfileBytes).digest("hex")
  ) {
    fail("build report Dockerfile digest does not match the pinned source");
  }
  for (const key of ["sourceDigest", "recipeDigest", "lockDigest"]) {
    if (report[key] !== metadata.sourceDigests[key])
      fail(`build report ${key} does not match the pinned source`);
  }
  exactKeys(
    report.images,
    ["runtime-base", "build-kit", "composition-core", "composition-story"],
    "build report images",
  );
  for (const [name, metadataName] of [
    ["runtime-base", "runtime-base-metadata.json"],
    ["build-kit", "build-kit-metadata.json"],
    ["composition-core", "composition-core-metadata.json"],
    ["composition-story", "composition-story-metadata.json"],
  ]) {
    validateImageMetadata(metadata[metadataName], name, report.images[name]);
  }
  for (const [key, digest] of [
    ["catalogSha256", metadata.catalogDigest],
    ["runtimeMetadataSha256", metadata.runtimeMetadataDigest],
    ["statementSha256", metadata.statementDigest],
  ]) {
    if (report[key] !== digest.slice("sha256:".length))
      fail(`build report ${key} does not match its metadata`);
  }
  const archiveBytes = Object.values(report.images).reduce(
    (total, entry) => total + entry.archiveSizeBytes,
    0,
  );
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes <= 0)
    fail("OCI archive size total is invalid");
  exactKeys(
    report.encryptedEvidence,
    ["fileName", "sha256", "sizeBytes", "maxSizeBytes"],
    "encrypted evidence report",
  );
  if (
    report.encryptedEvidence.fileName !== "producer-evidence.cms" ||
    typeof report.encryptedEvidence.sha256 !== "string" ||
    !hexPattern.test(report.encryptedEvidence.sha256) ||
    !Number.isSafeInteger(report.encryptedEvidence.sizeBytes) ||
    report.encryptedEvidence.sizeBytes <= 0 ||
    !Number.isSafeInteger(report.encryptedEvidence.maxSizeBytes) ||
    report.encryptedEvidence.maxSizeBytes !== 4 * 1024 * 1024 * 1024 ||
    report.encryptedEvidence.sizeBytes > report.encryptedEvidence.maxSizeBytes ||
    report.encryptedEvidence.sizeBytes < archiveBytes ||
    report.encryptedEvidence.sizeBytes > archiveBytes + 16 * 1024 * 1024
  ) {
    fail("encrypted evidence size exceeds the reviewed 4 GiB cap or has invalid metadata");
  }
}

function validateStatement(statement, metadata) {
  const catalog = metadata.catalog;
  const runtimeBaseDigest = catalog.runtimeBaseDigest;
  const buildKitDigest = catalog.buildKitDigest;
  const startedOn = statement?.predicate?.runDetails?.metadata?.startedOn;
  const finishedOn = statement?.predicate?.runDetails?.metadata?.finishedOn;
  const invocationId = statement?.predicate?.runDetails?.metadata?.invocationId;
  if (
    typeof startedOn !== "string" ||
    typeof finishedOn !== "string" ||
    new Date(startedOn).toISOString() !== startedOn ||
    new Date(finishedOn).toISOString() !== finishedOn ||
    Date.parse(finishedOn) < Date.parse(startedOn) ||
    typeof invocationId !== "string" ||
    !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      invocationId,
    )
  ) {
    fail("SLSA statement run metadata is invalid");
  }
  const expected = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: imageRepository, digest: { sha256: runtimeBaseDigest.slice("sha256:".length) } },
      {
        name: "scriptorium-build/v1/catalog.json",
        digest: { sha256: metadata.catalogDigest.slice("sha256:".length) },
      },
      {
        name: "scriptorium-platform/v1/runtime-metadata.json",
        digest: { sha256: metadata.runtimeMetadataDigest.slice("sha256:".length) },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: `${sourceOrigin}/blob/${revision}/Dockerfile`,
        externalParameters: {
          buildKitImage: `${imageRepository}@${buildKitDigest}`,
          producerRevision: revision,
          runtimeBaseImage: `${imageRepository}@${runtimeBaseDigest}`,
        },
        internalParameters: {
          catalogSourceDigest: catalog.sourceDigest,
          recipeDigest: catalog.recipeDigest,
          lockDigest: catalog.lockDigest,
        },
        resolvedDependencies: [
          { uri: `git+${sourceOrigin}`, digest: { gitCommit: revision } },
          {
            uri: `${sourceOrigin}/source-inventory/v1`,
            digest: { sha256: catalog.sourceDigest.slice("sha256:".length) },
          },
          {
            uri: `${sourceOrigin}/build-recipe/v1`,
            digest: { sha256: catalog.recipeDigest.slice("sha256:".length) },
          },
          {
            uri: `${sourceOrigin}/blob/${revision}/pnpm-lock.yaml`,
            digest: { sha256: catalog.lockDigest.slice("sha256:".length) },
          },
          {
            uri: `oci://${imageRepository}`,
            digest: { sha256: buildKitDigest.slice("sha256:".length) },
          },
        ],
      },
      runDetails: {
        builder: { id: `${sourceOrigin}/blob/${revision}/scripts/hosted-attestation.mjs` },
        metadata: { invocationId, startedOn, finishedOn },
      },
    },
  };
  if (canonicalJson(statement) !== canonicalJson(expected))
    fail(
      "SLSA subjects or dependencies do not bind the exact source, catalog, runtime metadata, and image digests",
    );
}

async function main() {
  const sourceRoot = process.env.SCRIPTORIUM_ROOT;
  const metadataDirectory = process.env.PRODUCER_METADATA_DIR;
  if (!sourceRoot || !metadataDirectory)
    fail("SCRIPTORIUM_ROOT and PRODUCER_METADATA_DIR are required");
  if (process.env.SCRIPTORIUM_REVISION !== revision)
    fail("workflow producer revision does not match the validator pin");
  const sourceHead = git(["rev-parse", "HEAD"], sourceRoot);
  const sourceStatus = git(["status", "--porcelain"], sourceRoot);
  const sourceRemote = git(["remote", "get-url", "origin"], sourceRoot);
  if (
    sourceHead !== revision ||
    sourceStatus !== "" ||
    ![
      "https://github.com/yohn-jp/scriptorium",
      "https://github.com/yohn-jp/scriptorium.git",
    ].includes(sourceRemote)
  ) {
    fail("signer source checkout is not the exact clean canonical producer revision");
  }

  const [catalogInput, runtimeInput, statementInput, reportInput, ...imageInputs] =
    await Promise.all([
      readJson(metadataDirectory, "build-catalog.json", { canonical: true }),
      readJson(metadataDirectory, "runtime-metadata.json", { canonical: true }),
      readJson(metadataDirectory, "provenance.statement.json", { canonical: true }),
      readJson(metadataDirectory, "build-report.json"),
      readJson(metadataDirectory, "runtime-base-metadata.json"),
      readJson(metadataDirectory, "build-kit-metadata.json"),
      readJson(metadataDirectory, "composition-core-metadata.json"),
      readJson(metadataDirectory, "composition-story-metadata.json"),
    ]);
  const sourceDigests = await calculateSourceDigests(sourceRoot);
  const dockerfileBytes = await readFile(path.join(sourceRoot, "Dockerfile"));
  const metadata = {
    catalog: catalogInput.value,
    catalogBytes: catalogInput.bytes,
    catalogDigest: sha256(catalogInput.bytes),
    runtimeMetadata: runtimeInput.value,
    runtimeMetadataBytes: runtimeInput.bytes,
    runtimeMetadataDigest: sha256(runtimeInput.bytes),
    statement: statementInput.value,
    statementBytes: statementInput.bytes,
    statementDigest: sha256(statementInput.bytes),
    sourceDigests,
    dockerfileBytes,
    "runtime-base-metadata.json": imageInputs[0].value,
    "build-kit-metadata.json": imageInputs[1].value,
    "composition-core-metadata.json": imageInputs[2].value,
    "composition-story-metadata.json": imageInputs[3].value,
  };
  validateBuildReport(reportInput.value, metadata);
  validateCatalog(metadata.catalog, sourceDigests, reportInput.value);
  validateRuntimeMetadata(metadata.runtimeMetadata);
  validateStatement(metadata.statement, metadata);
  process.stdout.write(`Validated producer revision ${revision}\n`);
  process.stdout.write(`Source digest: ${sourceDigests.sourceDigest}\n`);
  process.stdout.write(`Catalog digest: ${metadata.catalogDigest}\n`);
  process.stdout.write(`Runtime metadata digest: ${metadata.runtimeMetadataDigest}\n`);
  process.stdout.write(`SLSA statement digest: ${metadata.statementDigest}\n`);
  process.stdout.write(
    `Encrypted evidence size: ${reportInput.value.encryptedEvidence.sizeBytes} / ${reportInput.value.encryptedEvidence.maxSizeBytes} bytes\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
