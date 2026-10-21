#!/usr/bin/env node
/**
 * Construct the exact canonical Operator Admission payload from a previously
 * signed producer catalog, never from an admin-supplied manifest. This program
 * does not issue a release, mutate D1 or bypass Sigstore verification.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const EVIDENCE_TAG = /^producer-evidence-([1-9][0-9]{0,19})-([1-9][0-9]{0,2})$/u;
export const PRODUCER_IMAGE_REPOSITORY = "ghcr.io/yohn-jp/praetorium/scriptorium-producer";

export function createAdmissionManifest(input) {
  const { catalog, runtimeMetadata, version, sourceRevision, tag, evidenceTag } = input;
  if (!SEMVER.test(version) || typeof tag !== "string" || tag.replace(/^v/u, "") !== version)
    throw new Error("Selected Release tag must match its strict SemVer version");
  if (!SHA.test(sourceRevision) || !EVIDENCE_TAG.test(evidenceTag))
    throw new Error("Producer source revision or immutable evidence reference is invalid");
  if (!catalog || typeof catalog !== "object" ||
      catalog.contractVersion !== "scriptorium-build/v1" ||
      catalog.producerRevision !== sourceRevision ||
      !DIGEST.test(catalog.runtimeBaseDigest ?? "") ||
      !DIGEST.test(catalog.buildKitDigest ?? "") ||
      !Array.isArray(catalog.modules) || !Array.isArray(catalog.resourceProfiles))
    throw new Error("Producer catalog is not verified for the selected commit");
  if (!runtimeMetadata || typeof runtimeMetadata !== "object" ||
      runtimeMetadata.contractVersion !== "scriptorium-platform/v1" ||
      runtimeMetadata.producerRevision !== sourceRevision)
    throw new Error("Producer runtime metadata does not bind the selected commit");
  const reference =
    "https://github.com/yohn-jp/praetorium/releases/download/" + evidenceTag + "/provenance.sigstore.json";
  return {
    schemaVersion: 1,
    version,
    imageRepository: PRODUCER_IMAGE_REPOSITORY,
    catalog,
    runtimeMetadata,
    signatureRef: reference,
    provenanceRef: reference,
  };
}

async function main() {
  const sourceRevision = process.env.SCRIPTORIUM_REVISION ?? "";
  const tag = process.env.SCRIPTORIUM_TAG ?? "";
  const version = process.env.SCRIPTORIUM_RELEASE_VERSION ?? "";
  const evidenceTag = process.env.PRODUCER_EVIDENCE_TAG ?? "";
  const directory = process.env.PRODUCER_METADATA_DIR;
  const output = process.env.PRODUCER_RELEASE_MANIFEST_FILE;
  if (!directory || !output) throw new Error("Producer metadata/output paths are required");
  const [catalog, runtimeMetadata] = await Promise.all(
    ["build-catalog.json", "runtime-metadata.json"].map(async (filename) => {
      const bytes = await readFile(directory + "/" + filename);
      if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024)
        throw new Error("Producer metadata is unavailable or oversized");
      return JSON.parse(bytes.toString("utf8"));
    }),
  );
  const manifest = createAdmissionManifest({
    catalog, runtimeMetadata, version, sourceRevision, tag, evidenceTag,
  });
  await writeFile(output, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    // No source document or credentials in runner logs.
    console.error("Producer release admission manifest could not be constructed");
    process.exitCode = 1;
  });
}
