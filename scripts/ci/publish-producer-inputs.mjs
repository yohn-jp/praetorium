#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const expectedRevision = "008d5c429ec279a424cafd5b8c4cbee70a613b8e";
const expectedSourceOrigin = "https://github.com/yohn-jp/scriptorium";
const expectedLocalRepository = "127.0.0.1:5000/scriptorium/producer";
const expectedTargetRepository = "ghcr.io/yohn-jp/praetorium/scriptorium-producer";
const maximumArchiveBytes = 1024 * 1024 * 1024;
const maximumAggregateArchiveBytes = 1024 * 1024 * 1024;
const maximumJsonBytes = 16 * 1024 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(message);
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0)
    fail(`Missing required environment: ${name}`);
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !digestPattern.test(value))
    fail(`${label} is not a SHA-256 digest`);
  return value;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readRegularFile(directory, filename, maximumBytes = maximumJsonBytes) {
  const fullPath = path.join(directory, filename);
  const info = await lstat(fullPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumBytes) {
    fail(`${filename} is not a regular file within the allowed size`);
  }
  return { fullPath, bytes: await readFile(fullPath) };
}

async function regularFileInfo(directory, filename, maximumBytes) {
  const fullPath = path.join(directory, filename);
  const info = await lstat(fullPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumBytes) {
    fail(`${filename} is not a regular file within the allowed size`);
  }
  return { fullPath, sizeBytes: info.size };
}

async function readJson(directory, filename) {
  const { bytes } = await readRegularFile(directory, filename);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(`${filename} is not valid UTF-8 JSON`);
  }
}

function run(command, args, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, args, { encoding: null, maxBuffer });
  if (result.error) throw result.error;
  return result;
}

function runContainer(skopeoImage, args, mounts, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  return run(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      ...mounts.flatMap((mount) => ["--mount", mount]),
      skopeoImage,
      ...args,
    ],
    { maxBuffer },
  );
}

function parseArchiveIndex(filename, expectedDigest) {
  const result = run("tar", ["-xOf", filename, "index.json"], { maxBuffer: 1024 * 1024 });
  if (result.status !== 0) fail("OCI archive index could not be read");
  let index;
  try {
    index = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
  } catch {
    fail("OCI archive index is not valid UTF-8 JSON");
  }
  if (
    !index ||
    !Array.isArray(index.manifests) ||
    index.manifests.length !== 1 ||
    index.manifests[0]?.digest !== expectedDigest ||
    !Number.isSafeInteger(index.manifests[0]?.size) ||
    index.manifests[0].size <= 0
  ) {
    fail("OCI archive descriptor does not match the validated producer digest");
  }
}

function verifyRemoteManifest(skopeoImage, repository, digest, authMount) {
  const mounts = authMount ? [authMount] : [];
  const args = ["inspect", "--raw"];
  if (authMount) args.push("--authfile", "/auth/config.json");
  args.push(`docker://${repository}@${digest}`);
  const result = runContainer(skopeoImage, args, mounts);
  if (result.status === 0) {
    const actual = sha256(result.stdout);
    if (actual !== digest) fail("GHCR manifest readback differs from the producer digest");
    return { available: true, httpStatus: 200 };
  }
  const errorText = result.stderr.toString("utf8");
  const statusMatch = errorText.match(/\b(401|403)\b/u);
  return { available: false, httpStatus: statusMatch ? Number(statusMatch[1]) : null };
}

async function main() {
  const metadataDirectory = requireEnvironment("PRODUCER_METADATA_DIR");
  const signedDirectory = requireEnvironment("PRODUCER_SIGNED_METADATA_DIR");
  const publicInputsDirectory = requireEnvironment("PRODUCER_PUBLIC_INPUTS_DIR");
  const authDirectory = requireEnvironment("GHCR_AUTH_DIR");
  const skopeoImage = requireEnvironment("SKOPEO_IMAGE");
  const targetRepository = requireEnvironment("IMAGE_REPOSITORY");
  const revision = requireEnvironment("SCRIPTORIUM_REVISION");
  const runId = requireEnvironment("GITHUB_RUN_ID");
  const buildAttempt = requireEnvironment("PRODUCER_BUILD_ATTEMPT");
  const summaryPath = requireEnvironment("PUBLICATION_SUMMARY");

  if (revision !== expectedRevision || targetRepository !== expectedTargetRepository) {
    fail("Pinned source revision or Praetorium-owned target repository differs from policy");
  }
  if (!/^\d+$/u.test(runId) || !/^\d+$/u.test(buildAttempt))
    fail("Workflow build attempt identifier is invalid");

  const report = await readJson(metadataDirectory, "build-report.json");
  const catalogFile = await readRegularFile(metadataDirectory, "build-catalog.json");
  const runtimeFile = await readRegularFile(metadataDirectory, "runtime-metadata.json");
  const statementFile = await readRegularFile(metadataDirectory, "provenance.statement.json");
  const catalog = await readJson(metadataDirectory, "build-catalog.json");
  const statement = await readJson(metadataDirectory, "provenance.statement.json");
  const runtimeMetadata = await readJson(metadataDirectory, "runtime-metadata.json");

  if (
    report?.schemaVersion !== "praetorium-scriptorium-producer-verification/v1" ||
    report.producerRevision !== revision ||
    report.sourceOrigin !== expectedSourceOrigin ||
    report.imageRepository !== expectedLocalRepository ||
    report.cosignIdentity !==
      "https://github.com/yohn-jp/praetorium/.github/workflows/scriptorium-producer-verification.yml@refs/heads/main" ||
    report.cosignIssuer !== "https://token.actions.githubusercontent.com" ||
    report.registryPublication !==
      "deferred to separate Praetorium GHCR publisher after signer success" ||
    report.artifactPublication !== "ciphertext evidence plus two one-day OCI publication inputs"
  ) {
    fail("Build report does not identify the pinned canonical producer evidence");
  }

  const catalogSha256 = createHash("sha256").update(catalogFile.bytes).digest("hex");
  const runtimeSha256 = createHash("sha256").update(runtimeFile.bytes).digest("hex");
  const statementSha256 = createHash("sha256").update(statementFile.bytes).digest("hex");
  if (
    report.catalogSha256 !== catalogSha256 ||
    report.runtimeMetadataSha256 !== runtimeSha256 ||
    report.statementSha256 !== statementSha256 ||
    catalog.producerRevision !== revision ||
    runtimeMetadata.producerRevision !== revision ||
    catalog.runtimeBaseDigest !== report.images?.["runtime-base"]?.digest ||
    catalog.buildKitDigest !== report.images?.["build-kit"]?.digest
  ) {
    fail("Build report, catalog, runtime metadata, and statement hashes do not agree");
  }

  const signedMetadataDirectory = path.join(signedDirectory, "scriptorium-producer-metadata");
  for (const filename of [
    "build-catalog.json",
    "runtime-metadata.json",
    "provenance.statement.json",
  ]) {
    const signed = await readRegularFile(signedMetadataDirectory, filename);
    const original = await readRegularFile(metadataDirectory, filename);
    if (!signed.bytes.equals(original.bytes)) fail(`Signed artifact changed ${filename}`);
  }
  await readRegularFile(signedDirectory, "provenance.sigstore.json");

  const statementSubjects = new Map(
    (Array.isArray(statement.subject) ? statement.subject : []).map((subject) => [
      subject?.name,
      subject?.digest?.sha256,
    ]),
  );
  const buildDefinition = statement?.predicate?.buildDefinition;
  const expectedDigests = {
    "runtime-base": requireDigest(catalog.runtimeBaseDigest, "catalog Runtime Base digest"),
    "build-kit": requireDigest(catalog.buildKitDigest, "catalog Build Kit digest"),
  };
  if (
    statementSubjects.get(expectedLocalRepository) !== expectedDigests["runtime-base"].slice(7) ||
    statementSubjects.get("scriptorium-build/v1/catalog.json") !== catalogSha256 ||
    statementSubjects.get("scriptorium-platform/v1/runtime-metadata.json") !== runtimeSha256 ||
    buildDefinition?.externalParameters?.runtimeBaseImage !==
      `${expectedLocalRepository}@${expectedDigests["runtime-base"]}` ||
    buildDefinition?.externalParameters?.buildKitImage !==
      `${expectedLocalRepository}@${expectedDigests["build-kit"]}`
  ) {
    fail("Signed statement subjects or producer image materials do not bind the catalog digests");
  }

  const cosignBundle = await readRegularFile(signedDirectory, "provenance.sigstore.json");
  let cosignBundleDocument;
  try {
    cosignBundleDocument = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(cosignBundle.bytes),
    );
  } catch {
    fail("Sigstore bundle is invalid");
  }
  const dssePayload = cosignBundleDocument?.dsseEnvelope?.payload;
  if (
    typeof dssePayload !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(dssePayload)
  ) {
    fail("Sigstore bundle does not contain a valid DSSE payload");
  }
  const decodedDssePayload = Buffer.from(dssePayload, "base64");
  if (
    decodedDssePayload.toString("base64") !== dssePayload ||
    !decodedDssePayload.equals(statementFile.bytes)
  ) {
    fail("Sigstore DSSE payload differs from the validated producer statement bytes");
  }

  const authFile = path.join(authDirectory, "config.json");
  const authInfo = await lstat(authFile);
  if (!authInfo.isFile() || authInfo.isSymbolicLink() || (authInfo.mode & 0o077) !== 0) {
    fail("GHCR authentication file is not a private regular file");
  }

  const imageEntries = [
    { name: "runtime-base", archive: "runtime-base.oci.tar" },
    { name: "build-kit", archive: "build-kit.oci.tar" },
  ];
  const prepared = [];
  let aggregateBytes = 0;
  for (const image of imageEntries) {
    const reportEntry = report.images?.[image.name];
    const digest = requireDigest(reportEntry?.digest, `${image.name} report digest`);
    if (
      reportEntry.reference !== `${expectedLocalRepository}@${digest}` ||
      reportEntry.archive !== image.archive ||
      digest !== expectedDigests[image.name]
    ) {
      fail(`${image.name} report reference differs from signed producer metadata`);
    }
    const { fullPath, sizeBytes } = await regularFileInfo(
      publicInputsDirectory,
      image.archive,
      maximumArchiveBytes,
    );
    if (sizeBytes !== reportEntry.archiveSizeBytes) {
      fail(`${image.name} OCI archive size differs from the producer build report`);
    }
    aggregateBytes += sizeBytes;
    if (aggregateBytes > maximumAggregateArchiveBytes) {
      fail("Opt-in public OCI inputs exceed the reviewed 1 GiB aggregate cap");
    }
    parseArchiveIndex(fullPath, digest);
    prepared.push({ ...image, fullPath, digest, sizeBytes });
  }

  const authMount = `type=bind,src=${authFile},dst=/auth/config.json,readonly`;
  const publications = [];
  for (const image of prepared) {
    const tag = `source-${revision}-run-${runId}-build-attempt-${buildAttempt}-${image.name}`;
    const copyResult = runContainer(
      skopeoImage,
      [
        "copy",
        "--preserve-digests",
        "--authfile",
        "/auth/config.json",
        `oci-archive:/inputs/${image.archive}`,
        `docker://${targetRepository}:${tag}`,
      ],
      [`type=bind,src=${image.fullPath},dst=/inputs/${image.archive},readonly`, authMount],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    if (copyResult.status !== 0) fail(`Skopeo digest-preserving copy failed for ${image.name}`);

    const authenticatedReadback = verifyRemoteManifest(
      skopeoImage,
      targetRepository,
      image.digest,
      authMount,
    );
    if (!authenticatedReadback.available)
      fail(`Authenticated GHCR digest readback failed for ${image.name}`);
    const anonymousReadback = verifyRemoteManifest(
      skopeoImage,
      targetRepository,
      image.digest,
      null,
    );
    publications.push({
      component: image.name,
      tag,
      digest: image.digest,
      archiveSizeBytes: image.sizeBytes,
      authenticatedReadback: "exact digest",
      anonymousReadback: {
        available: anonymousReadback.available,
        httpStatus: anonymousReadback.httpStatus,
      },
    });
  }

  const summary = {
    schemaVersion: "praetorium-scriptorium-producer-publication/v1",
    sourceRevision: revision,
    targetRepository,
    workflowRun: { id: runId, buildAttempt },
    archiveAggregateBytes: aggregateBytes,
    archiveMaximumBytes: maximumAggregateArchiveBytes,
    images: publications,
    packageVisibilityNote:
      "A successful authenticated push does not make a GHCR package public; anonymousReadback is the visibility evidence.",
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  for (const image of publications) {
    const state = image.anonymousReadback.available
      ? "anonymous pull verified"
      : `anonymous pull blocked (HTTP ${image.anonymousReadback.httpStatus ?? "unavailable"})`;
    process.stdout.write(`${image.component}: ${image.digest}; ${state}\n`);
  }
  const unavailableImages = publications.filter((image) => !image.anonymousReadback.available);
  if (unavailableImages.length > 0) {
    const blocked = unavailableImages
      .map(
        (image) => `${image.component}=HTTP ${image.anonymousReadback.httpStatus ?? "unavailable"}`,
      )
      .join(", ");
    fail(
      `PUBLIC_AVAILABILITY_BLOCKED: authenticated digests were published, but anonymous pull is unavailable for ${blocked}`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Producer publication failed"}\n`,
  );
  process.exitCode = 1;
});
