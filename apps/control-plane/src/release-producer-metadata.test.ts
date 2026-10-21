import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BuildCatalog, RuntimeMetadata } from "@praetorium/contracts";
import type { VerifiedReleaseAttestation } from "@praetorium/application/releases";
import { verifyReleaseProducerMetadata } from "./release-producer-metadata.js";

const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const PRODUCER_REVISION = "b".repeat(40);
const SIGNATURE_REF = "https://evidence.example/signed-slsa-bundle";
const PROVENANCE_REF = "https://evidence.example/provenance";

function metadata() {
  const catalog: BuildCatalog = {
    contractVersion: "scriptorium-build/v1",
    producerRevision: PRODUCER_REVISION,
    runtimeBaseDigest: IMAGE_DIGEST,
    buildKitDigest: `sha256:${"c".repeat(64)}`,
    recipeDigest: `sha256:${"d".repeat(64)}`,
    lockDigest: `sha256:${"e".repeat(64)}`,
    sourceDigest: `sha256:${"f".repeat(64)}`,
    supportedPlatforms: ["linux/amd64"],
    modules: [],
    baseResources: { cpuMilli: 100, memoryMiB: 256, ephemeralStorageMiB: 512 },
    sharedResourceGroups: [],
    resourceProfiles: [],
  };
  const runtimeMetadata: RuntimeMetadata = {
    contractVersion: "scriptorium-platform/v1",
    producerRevision: PRODUCER_REVISION,
    listener: { port: 3000 },
    paths: {
      liveness: "/health/live",
      readiness: "/health/ready",
      metadata: "/api/platform/v1/metadata",
      shutdown: "/api/platform/v1/shutdown",
      status: "/api/platform/v1/status",
      quiesce: "/api/platform/v1/quiesce",
      resume: "/api/platform/v1/resume",
    },
    shutdownTimeoutSeconds: 30,
  };
  return { catalog, runtimeMetadata };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function attestation(
  catalog: BuildCatalog,
  runtimeMetadata: RuntimeMetadata,
  overrides: Partial<VerifiedReleaseAttestation> = {},
): VerifiedReleaseAttestation {
  return {
    bundleRef: SIGNATURE_REF,
    predicateType: "https://slsa.dev/provenance/v1",
    subjects: [
      { name: "scriptorium-runtime", sha256: IMAGE_DIGEST.slice("sha256:".length) },
      { name: "scriptorium-build/v1/catalog.json", sha256: sha256(catalog) },
      { name: "scriptorium-platform/v1/runtime-metadata.json", sha256: sha256(runtimeMetadata) },
    ],
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  const value = metadata();
  return {
    imageRepository: "ghcr.io/yohn-jp/scriptorium-runtime",
    imageDigest: IMAGE_DIGEST,
    producerRevision: PRODUCER_REVISION,
    ...value,
    signatureRef: SIGNATURE_REF,
    provenanceRef: PROVENANCE_REF,
    attestation: attestation(value.catalog, value.runtimeMetadata),
    ...overrides,
  };
}

describe("signed Scriptorium release metadata", () => {
  it("accepts verified Source v2 subjects only from the canonical proof location", async () => {
    const base = input();
    const reference = "https://control.praetorium.yohn.jp/internal/source-proofs/sr_11111111-1111-4111-8111-111111111111";
    const candidate = {
      ...base, signatureRef: reference, provenanceRef: reference,
      attestation: { ...base.attestation, bundleRef: reference,
        predicateType: "https://praetorium.yohn.jp/attestation/source-build/v2" },
    };
    await expect(verifyReleaseProducerMetadata(candidate)).resolves.toMatchObject({ kind: "verified" });
    const foreign = reference.replace("control.praetorium.yohn.jp", "evidence.example");
    await expect(verifyReleaseProducerMetadata({
      ...candidate, signatureRef: foreign, provenanceRef: foreign,
      attestation: { ...candidate.attestation, bundleRef: foreign },
    })).resolves.toMatchObject({ kind: "rejected" });
    await expect(verifyReleaseProducerMetadata({
      ...candidate, catalog: { ...base.catalog, sourceDigest: "sha256:" + "9".repeat(64) },
    })).resolves.toMatchObject({ kind: "rejected" });
  });

  it("accepts only the strict catalog and runtime metadata bound as subjects in the verified SLSA bundle", async () => {
    await expect(verifyReleaseProducerMetadata(input())).resolves.toMatchObject({
      kind: "verified",
      evidence: [
        expect.stringContaining("scriptorium-build/v1/catalog.json"),
        expect.stringContaining("scriptorium-platform/v1/runtime-metadata.json"),
        expect.stringContaining(PRODUCER_REVISION),
      ],
    });
  });

  it("rejects caller metadata that differs from the signed catalog", async () => {
    const value = metadata();
    const alteredCatalog = { ...value.catalog, sourceDigest: `sha256:${"9".repeat(64)}` };
    await expect(
      verifyReleaseProducerMetadata({
        ...input(),
        catalog: alteredCatalog,
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "signed SLSA subjects do not bind the supplied producer metadata" });
  });

  it("rejects missing, duplicate, wrong-ref and wrong-predicate attestations", async () => {
    const base = input();
    const verified = base.attestation;
    const withoutCatalog = {
      ...verified,
      subjects: verified.subjects.filter(({ name }) => name !== "scriptorium-build/v1/catalog.json"),
    };
    const duplicatedCatalog = {
      ...verified,
      subjects: [
        ...verified.subjects,
        verified.subjects.find(({ name }) => name === "scriptorium-build/v1/catalog.json")!,
      ],
    };

    const { attestation: _missing, ...withoutAttestation } = base;
    void _missing;
    await expect(verifyReleaseProducerMetadata(withoutAttestation)).resolves.toMatchObject({ kind: "rejected" });
    await expect(verifyReleaseProducerMetadata({ ...base, attestation: withoutCatalog })).resolves.toMatchObject({ kind: "rejected" });
    await expect(verifyReleaseProducerMetadata({ ...base, attestation: duplicatedCatalog })).resolves.toMatchObject({ kind: "rejected" });
    await expect(
      verifyReleaseProducerMetadata({
        ...base,
        attestation: { ...verified, bundleRef: PROVENANCE_REF },
      }),
    ).resolves.toMatchObject({ kind: "rejected" });
    await expect(
      verifyReleaseProducerMetadata({
        ...base,
        attestation: { ...verified, predicateType: "https://example.com/untrusted" },
      }),
    ).resolves.toMatchObject({ kind: "rejected" });
  });

  it("rejects inconsistent image and producer revision bindings", async () => {
    await expect(
      verifyReleaseProducerMetadata({ ...input(), producerRevision: "9".repeat(40) }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "producer metadata does not match the admitted image or revision" });
    await expect(
      verifyReleaseProducerMetadata({ ...input(), imageDigest: `sha256:${"9".repeat(64)}` }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "producer metadata does not match the admitted image or revision" });
  });
});
