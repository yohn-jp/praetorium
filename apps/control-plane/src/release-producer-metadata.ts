import {
  BuildCatalogSchema,
  RuntimeMetadataSchema,
  type BuildCatalog,
  type RuntimeMetadata,
} from "@praetorium/contracts";
import type {
  ReleaseAdmissionResult,
  VerifiedReleaseAttestation,
} from "@praetorium/application/releases";

export type ReleaseProducerMetadataInput = {
  readonly imageRepository: string;
  readonly imageDigest: string;
  readonly producerRevision: string;
  readonly catalog: BuildCatalog;
  readonly runtimeMetadata: RuntimeMetadata;
  readonly signatureRef: string;
  readonly provenanceRef: string;
  readonly attestation?: VerifiedReleaseAttestation;
};

const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const PRAETORIUM_SOURCE_BUILD_V1 = "https://praetorium.yohn.jp/attestation/source-build/v1";
const PRAETORIUM_SOURCE_BUILD_V2 = "https://praetorium.yohn.jp/attestation/source-build/v2";
const CATALOG_SUBJECT = "scriptorium-build/v1/catalog.json";
const RUNTIME_METADATA_SUBJECT = "scriptorium-platform/v1/runtime-metadata.json";

/**
 * Verifies the caller's strict producer metadata against the subjects from the
 * already signature-verified Scriptorium SLSA bundle. The digest input format
 * is shared with Scriptorium: UTF-8, compact JSON, recursively sorted object
 * keys, preserved array order, and JSON.stringify primitive encoding.
 */
export async function verifyReleaseProducerMetadata(
  input: ReleaseProducerMetadataInput,
): Promise<ReleaseAdmissionResult> {
  const catalog = BuildCatalogSchema.safeParse(input.catalog);
  const runtimeMetadata = RuntimeMetadataSchema.safeParse(input.runtimeMetadata);
  if (!catalog.success || !runtimeMetadata.success) {
    return { kind: "rejected", reason: "producer metadata does not match the strict shared schemas" };
  }
  if (
    catalog.data.runtimeBaseDigest !== input.imageDigest ||
    catalog.data.producerRevision !== input.producerRevision ||
    runtimeMetadata.data.producerRevision !== input.producerRevision
  ) {
    return { kind: "rejected", reason: "producer metadata does not match the admitted image or revision" };
  }
  const attestation = input.attestation;
  if (!attestation) {
    return { kind: "rejected", reason: "signature-verified producer metadata subjects are unavailable" };
  }
  if (
    !isHttpsReference(input.signatureRef) ||
    !isHttpsReference(input.provenanceRef) ||
    attestation.bundleRef !== input.signatureRef ||
    (attestation.predicateType !== SLSA_PROVENANCE_V1 &&
      !([PRAETORIUM_SOURCE_BUILD_V1, PRAETORIUM_SOURCE_BUILD_V2].includes(attestation.predicateType) &&
        /^https:\/\/control\.praetorium\.yohn\.jp\/internal\/source-proofs\/sr_[0-9a-f-]{36}$/u.test(input.signatureRef)))
  ) {
    return { kind: "rejected", reason: "producer attestation does not match the admitted SLSA bundle" };
  }

  const subjectByName = new Map<string, string[]>();
  for (const subject of attestation.subjects) {
    const digests = subjectByName.get(subject.name) ?? [];
    digests.push(subject.sha256);
    subjectByName.set(subject.name, digests);
  }
  const catalogDigest = await canonicalJsonSha256(catalog.data);
  const runtimeMetadataDigest = await canonicalJsonSha256(runtimeMetadata.data);
  if (
    !hasExactDigest(subjectByName, CATALOG_SUBJECT, catalogDigest) ||
    !hasExactDigest(subjectByName, RUNTIME_METADATA_SUBJECT, runtimeMetadataDigest)
  ) {
    return { kind: "rejected", reason: "signed SLSA subjects do not bind the supplied producer metadata" };
  }

  const imageDigest = input.imageDigest.slice("sha256:".length);
  if (!attestation.subjects.some(({ sha256 }) => sha256 === imageDigest)) {
    return { kind: "rejected", reason: "signed SLSA subjects do not bind the runtime base image" };
  }
  return {
    kind: "verified",
    evidence: [
      `signed producer catalog subject ${CATALOG_SUBJECT} matched ${catalogDigest}`,
      `signed runtime metadata subject ${RUNTIME_METADATA_SUBJECT} matched ${runtimeMetadataDigest}`,
      `signed producer revision ${input.producerRevision} matches the immutable runtime base image`,
    ],
  };
}

function isHttpsReference(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function hasExactDigest(subjects: ReadonlyMap<string, readonly string[]>, name: string, digest: string): boolean {
  const values = subjects.get(name);
  return values?.length === 1 && values[0] === digest.slice("sha256:".length);
}

async function canonicalJsonSha256(value: unknown): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value) ?? "null";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("producer metadata contains a non-finite number");
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("producer metadata is not JSON data");
  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}
