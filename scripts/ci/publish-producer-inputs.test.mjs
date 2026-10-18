import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";

const revision = "008d5c429ec279a424cafd5b8c4cbee70a613b8e";
const localRepository = "127.0.0.1:5000/scriptorium/producer";
const targetRepository = "ghcr.io/yohn-jp/praetorium/scriptorium-producer";
const publisherScript = path.join(import.meta.dirname, "publish-producer-inputs.mjs");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(filename, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  await writeFile(filename, bytes);
  return bytes;
}

async function createFixture({
  badSubject = false,
  badCatalogSha = false,
  badArchiveDigest = false,
  badBundlePayload = false,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "praetorium-publisher-test-"));
  const metadata = path.join(root, "metadata");
  const signed = path.join(root, "signed");
  const signedMetadata = path.join(signed, "scriptorium-producer-metadata");
  const inputs = path.join(root, "inputs");
  const auth = path.join(root, "auth");
  const fakeBin = path.join(root, "bin");
  for (const directory of [metadata, signedMetadata, inputs, auth, fakeBin]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  const runtimeManifest = Buffer.from('{"schemaVersion":2,"fixture":"runtime-base"}\n');
  const buildKitManifest = Buffer.from('{"schemaVersion":2,"fixture":"build-kit"}\n');
  const runtimeDigest = `sha256:${sha256(runtimeManifest)}`;
  const buildKitDigest = `sha256:${sha256(buildKitManifest)}`;
  const runtimeMetadataBytes = await writeJson(path.join(metadata, "runtime-metadata.json"), {
    producerRevision: revision,
  });
  const catalogBytes = await writeJson(path.join(metadata, "build-catalog.json"), {
    producerRevision: revision,
    runtimeBaseDigest: runtimeDigest,
    buildKitDigest,
  });
  const statement = {
    subject: [
      {
        name: localRepository,
        digest: { sha256: badSubject ? "0".repeat(64) : sha256(runtimeMetadataBytes) },
      },
      { name: "scriptorium-build/v1/catalog.json", digest: { sha256: sha256(catalogBytes) } },
      {
        name: "scriptorium-platform/v1/runtime-metadata.json",
        digest: { sha256: sha256(runtimeMetadataBytes) },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          runtimeBaseImage: `${localRepository}@${runtimeDigest}`,
          buildKitImage: `${localRepository}@${buildKitDigest}`,
        },
      },
    },
  };
  if (!badSubject) {
    statement.subject[0].digest.sha256 = runtimeDigest.slice("sha256:".length);
  }
  const statementBytes = await writeJson(
    path.join(metadata, "provenance.statement.json"),
    statement,
  );
  const images = {
    "runtime-base": {
      digest: runtimeDigest,
      reference: `${localRepository}@${runtimeDigest}`,
      archive: "runtime-base.oci.tar",
      archiveSizeBytes: 0,
    },
    "build-kit": {
      digest: buildKitDigest,
      reference: `${localRepository}@${buildKitDigest}`,
      archive: "build-kit.oci.tar",
      archiveSizeBytes: 0,
    },
  };
  const report = {
    schemaVersion: "praetorium-scriptorium-producer-verification/v1",
    producerRevision: revision,
    sourceOrigin: "https://github.com/yohn-jp/scriptorium",
    imageRepository: localRepository,
    cosignIdentity:
      "https://github.com/yohn-jp/praetorium/.github/workflows/scriptorium-producer-verification.yml@refs/heads/main",
    cosignIssuer: "https://token.actions.githubusercontent.com",
    registryPublication: "deferred to separate Praetorium GHCR publisher after signer success",
    artifactPublication: "ciphertext evidence plus two one-day OCI publication inputs",
    catalogSha256: badCatalogSha ? "f".repeat(64) : sha256(catalogBytes),
    runtimeMetadataSha256: sha256(runtimeMetadataBytes),
    statementSha256: sha256(statementBytes),
    images,
  };
  await writeJson(path.join(metadata, "build-report.json"), report);
  await writeFile(path.join(signedMetadata, "build-catalog.json"), catalogBytes);
  await writeFile(path.join(signedMetadata, "runtime-metadata.json"), runtimeMetadataBytes);
  await writeFile(path.join(signedMetadata, "provenance.statement.json"), statementBytes);
  const bundlePayload = badBundlePayload
    ? Buffer.from('{"statement":"different"}\n')
    : statementBytes;
  await writeJson(path.join(signed, "provenance.sigstore.json"), {
    dsseEnvelope: { payload: bundlePayload.toString("base64") },
  });

  for (const [name, manifest, digest] of [
    ["runtime-base", runtimeManifest, runtimeDigest],
    ["build-kit", buildKitManifest, buildKitDigest],
  ]) {
    const imageDirectory = path.join(root, `${name}-layout`);
    await mkdir(imageDirectory);
    const descriptorDigest =
      badArchiveDigest && name === "runtime-base" ? `sha256:${"0".repeat(64)}` : digest;
    await writeJson(path.join(imageDirectory, "index.json"), {
      schemaVersion: 2,
      manifests: [{ digest: descriptorDigest, size: manifest.byteLength }],
    });
    const archive = path.join(inputs, `${name}.oci.tar`);
    const tarResult = spawnSync("tar", ["-cf", archive, "-C", imageDirectory, "index.json"]);
    assert.equal(tarResult.status, 0, "fixture OCI archive creation succeeds");
    images[name].archiveSizeBytes = (await readFile(archive)).byteLength;
  }
  await writeJson(path.join(metadata, "build-report.json"), report);
  await writeFile(path.join(auth, "config.json"), '{"auths":{}}\n', { mode: 0o600 });

  const traceFile = path.join(root, "docker-trace.jsonl");
  const dockerStub = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.DOCKER_TRACE_FILE, JSON.stringify(args) + "\\n");
if (args.includes("copy")) process.exit(0);
if (!args.includes("inspect")) process.exit(21);
if (!args.includes("--authfile") && process.env.ANONYMOUS_BLOCKED === "true") {
  process.stderr.write("denied: HTTP 403 Forbidden\\n");
  process.exit(1);
}
const reference = args.at(-1);
const digest = reference.slice(reference.lastIndexOf("@") + 1);
if (digest === process.env.RUNTIME_DIGEST) process.stdout.write(Buffer.from(process.env.RUNTIME_MANIFEST_B64, "base64"));
else if (digest === process.env.BUILDKIT_DIGEST) process.stdout.write(Buffer.from(process.env.BUILDKIT_MANIFEST_B64, "base64"));
else process.exit(22);
`;
  const dockerPath = path.join(fakeBin, "docker");
  await writeFile(dockerPath, dockerStub, { mode: 0o700 });

  return {
    root,
    metadata,
    signed,
    inputs,
    auth,
    fakeBin,
    traceFile,
    runtimeDigest,
    buildKitDigest,
    runtimeManifest,
    buildKitManifest,
  };
}

function runPublisher(fixture, { anonymousBlocked = false } = {}) {
  const env = {
    ...process.env,
    PATH: `${fixture.fakeBin}:${process.env.PATH}`,
    PRODUCER_METADATA_DIR: fixture.metadata,
    PRODUCER_SIGNED_METADATA_DIR: fixture.signed,
    PRODUCER_PUBLIC_INPUTS_DIR: fixture.inputs,
    GHCR_AUTH_DIR: fixture.auth,
    SKOPEO_IMAGE: "quay.io/skopeo/stable@sha256:fixture",
    IMAGE_REPOSITORY: targetRepository,
    SCRIPTORIUM_REVISION: revision,
    GITHUB_RUN_ID: "9876543210",
    PRODUCER_RUN_ID: "1234567890",
    PRODUCER_BUILD_ATTEMPT: "2",
    PUBLICATION_SUMMARY: path.join(fixture.root, "summary.json"),
    DOCKER_TRACE_FILE: fixture.traceFile,
    RUNTIME_DIGEST: fixture.runtimeDigest,
    BUILDKIT_DIGEST: fixture.buildKitDigest,
    RUNTIME_MANIFEST_B64: fixture.runtimeManifest.toString("base64"),
    BUILDKIT_MANIFEST_B64: fixture.buildKitManifest.toString("base64"),
    ANONYMOUS_BLOCKED: String(anonymousBlocked),
  };
  return spawnSync(process.execPath, [publisherScript], { env, encoding: "utf8" });
}

async function dockerTrace(fixture) {
  try {
    return (await readFile(fixture.traceFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

test("valid digest-bound metadata copies both exact OCI descriptors", async () => {
  const fixture = await createFixture();
  try {
    const result = runPublisher(fixture);
    assert.equal(result.status, 0, result.stderr);
    const trace = await dockerTrace(fixture);
    const copyCommands = trace.filter((args) => args.includes("copy"));
    assert.equal(copyCommands.length, 2);
    assert.ok(
      copyCommands.every((args) =>
        args.some((argument) =>
          argument.startsWith(
            `docker://${targetRepository}:source-${revision}-run-1234567890-build-attempt-2-`,
          ),
        ),
      ),
    );
    const summary = JSON.parse(await readFile(path.join(fixture.root, "summary.json"), "utf8"));
    assert.deepEqual(summary.producerWorkflowRun, { id: "1234567890", attempt: "2" });
    assert.deepEqual(summary.publisherWorkflowRun, { id: "9876543210" });
    assert.deepEqual(
      summary.images.map((image) => image.digest),
      [fixture.runtimeDigest, fixture.buildKitDigest],
    );
    assert.ok(summary.images.every((image) => image.anonymousReadback.available));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("private-package anonymous 403 is recorded without hiding authenticated digest success", async () => {
  const fixture = await createFixture();
  try {
    const result = runPublisher(fixture, { anonymousBlocked: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PUBLIC_AVAILABILITY_BLOCKED/u);
    const trace = await dockerTrace(fixture);
    assert.equal(trace.filter((args) => args.includes("copy")).length, 2);
    const summary = JSON.parse(await readFile(path.join(fixture.root, "summary.json"), "utf8"));
    assert.ok(summary.images.every((image) => !image.anonymousReadback.available));
    assert.ok(summary.images.every((image) => image.anonymousReadback.httpStatus === 403));
    assert.ok(summary.images.every((image) => image.authenticatedReadback === "exact digest"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "wrong signed image subject", options: { badSubject: true } },
  { name: "wrong catalog hash", options: { badCatalogSha: true } },
  { name: "wrong OCI archive descriptor", options: { badArchiveDigest: true } },
  { name: "bundle DSSE payload mismatch", options: { badBundlePayload: true } },
]) {
  test(`${scenario.name} is rejected before any registry copy`, async () => {
    const fixture = await createFixture(scenario.options);
    try {
      const result = runPublisher(fixture);
      assert.notEqual(result.status, 0);
      assert.equal((await dockerTrace(fixture)).filter((args) => args.includes("copy")).length, 0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}
