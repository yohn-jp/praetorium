import {
  buildKey as computeBuildKey,
  BuilderArtifactStatementSchema,
  BuilderSignatureSchema,
  canonicalBuildInput,
  CompositionManifestSchema,
  validateCompositionBindings,
  type BuildInput,
} from "@praetorium/contracts";
import { isSha256Digest, sha256Digest, type Sha256Digest } from "./digest.js";
import type {
  ArtifactCandidate,
  ArtifactRegistryProvider,
  ArtifactPlatform,
  BuilderArtifactStatement,
  BuilderSignature,
  BuilderSignatureVerifier,
  OciPlatform,
  VerifiedArtifact,
} from "./types.js";

const MAX_COMPOSITION_MANIFEST_BYTES = 2 * 1024 * 1024;

export type ArtifactAdmissionErrorCode =
  | "invalid_candidate"
  | "build_input_mismatch"
  | "untrusted_signer"
  | "registry_unavailable"
  | "registry_mismatch"
  | "composition_content_mismatch"
  | "composition_invalid";

export class ArtifactAdmissionError extends Error {
  constructor(readonly code: ArtifactAdmissionErrorCode, message: string) {
    super(message);
    this.name = "ArtifactAdmissionError";
  }
}

function parseStatement(value: unknown): BuilderArtifactStatement | null {
  const parsed = BuilderArtifactStatementSchema.safeParse(value);
  if (!parsed.success) return null;
  for (let index = 1; index < parsed.data.resolvedModules.length; index += 1) {
    if (parsed.data.resolvedModules[index - 1]!.id >= parsed.data.resolvedModules[index]!.id) return null;
  }
  return parsed.data;
}

function parseSignature(value: unknown): BuilderSignature | null {
  const parsed = BuilderSignatureSchema.safeParse(value);
  if (!parsed.success) return null;
  try {
    return Uint8Array.from(atob(parsed.data.signature), (character) => character.charCodeAt(0)).byteLength === 64
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

function parseCandidate(value: unknown): ArtifactCandidate | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "statement") || !Object.hasOwn(record, "signature")) return null;
  const statement = parseStatement(record.statement);
  const signature = parseSignature(record.signature);
  return statement && signature ? { statement, signature } : null;
}

function ociPlatform(platform: ArtifactPlatform): OciPlatform {
  const [os, architecture] = platform.split("/");
  return { os: os!, architecture: architecture! };
}

function samePlatform(left: OciPlatform, right: ArtifactPlatform): boolean {
  return `${left.os}/${left.architecture}` === right;
}

function safeTime(clock: () => Date): string {
  const value = clock();
  if (!Number.isFinite(value.getTime())) throw new TypeError("artifact admission clock returned an invalid time");
  return value.toISOString();
}

/** Verifies signed build output against persisted BuildInput and live OCI bytes. */
export class ArtifactAdmissionService {
  constructor(
    private readonly registry: ArtifactRegistryProvider,
    private readonly signer: BuilderSignatureVerifier,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async verifyCandidate(candidateInput: unknown, expectedInputValue: BuildInput): Promise<VerifiedArtifact> {
    const candidate = parseCandidate(candidateInput);
    if (!candidate) throw new ArtifactAdmissionError("invalid_candidate", "build artifact candidate is malformed");
    const { statement, signature } = candidate;

    let expectedInput: BuildInput;
    let canonicalInput: string;
    let normalizedInput: BuildInput;
    let expectedBuildKey: string;
    try {
      canonicalInput = canonicalBuildInput(expectedInputValue);
      normalizedInput = JSON.parse(canonicalInput) as BuildInput;
      expectedInput = expectedInputValue;
      expectedBuildKey = await computeBuildKey(expectedInputValue);
    } catch {
      throw new ArtifactAdmissionError("build_input_mismatch", "persisted build input is invalid");
    }
    if (
      !isSha256Digest(expectedBuildKey) ||
      statement.buildKey !== expectedBuildKey ||
      statement.producerRevision !== normalizedInput.producerRevision ||
      statement.artifact.platform !== normalizedInput.platform ||
      canonicalBuildInput({
        ...normalizedInput,
        resolvedModules: statement.resolvedModules,
      }) !== canonicalInput
    ) {
      throw new ArtifactAdmissionError("build_input_mismatch", "signed artifact does not match the persisted immutable build input");
    }

    const signerResult = await this.signer.verify(statement, signature);
    if (!signerResult.verified || signerResult.keyId !== signature.keyId) {
      throw new ArtifactAdmissionError("untrusted_signer", signerResult.reason ?? "operator signature is not trusted");
    }

    let image: Awaited<ReturnType<ArtifactRegistryProvider["verifyImage"]>>;
    let composition: Awaited<ReturnType<ArtifactRegistryProvider["readBlob"]>>;
    try {
      [image, composition] = await Promise.all([
        this.registry.verifyImage(
          statement.artifact.repository,
          statement.artifact.digest,
          ociPlatform(statement.artifact.platform),
        ),
        this.registry.readBlob(
          statement.compositionManifest.repository,
          statement.compositionManifest.digest,
          MAX_COMPOSITION_MANIFEST_BYTES,
        ),
      ]);
    } catch (error) {
      const code = isRegistryUnavailable(error) ? "registry_unavailable" : "registry_mismatch";
      throw new ArtifactAdmissionError(code, "registry could not verify all artifact content and references");
    }

    if (
      image.repository !== statement.artifact.repository ||
      image.manifestDigest !== statement.artifact.digest ||
      image.platformManifestDigest !== statement.artifact.platformManifestDigest ||
      !samePlatform(image.platform, statement.artifact.platform) ||
      !isSha256Digest(image.configDigest) ||
      !Number.isSafeInteger(image.reachableLayerBytes) ||
      image.reachableLayerBytes < 0 ||
      !Array.isArray(image.layerDescriptors) ||
      image.layerDescriptors.some((layer) => !isSha256Digest(layer.digest) || !Number.isSafeInteger(layer.size) || layer.size < 0)
    ) {
      throw new ArtifactAdmissionError("registry_mismatch", "registry image identity or selected platform does not match the signed statement");
    }
    if (
      composition.digest !== statement.compositionManifest.digest ||
      !Number.isSafeInteger(composition.size) ||
      composition.size < 1 ||
      composition.size > MAX_COMPOSITION_MANIFEST_BYTES ||
      composition.bytes.byteLength !== composition.size ||
      await sha256Digest(composition.bytes) !== statement.compositionManifest.digest
    ) {
      throw new ArtifactAdmissionError("composition_content_mismatch", "composition manifest bytes do not match the signed digest");
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(composition.bytes));
    } catch {
      throw new ArtifactAdmissionError("composition_invalid", "composition manifest is not valid UTF-8 JSON");
    }
    const parsedComposition = CompositionManifestSchema.safeParse(decoded);
    if (!parsedComposition.success) {
      throw new ArtifactAdmissionError("composition_invalid", "composition manifest does not match the producer schema");
    }
    const compositionManifest = parsedComposition.data;
    let isBound = false;
    try {
      isBound =
        canonicalBuildInput(compositionManifest.buildInput) === canonicalInput &&
        compositionManifest.buildKey === statement.buildKey &&
        compositionManifest.producerRevision === statement.producerRevision &&
        compositionManifest.platform === statement.artifact.platform &&
        JSON.stringify(compositionManifest.resolvedModules) === JSON.stringify(statement.resolvedModules) &&
        await validateCompositionBindings(compositionManifest);
    } catch {
      isBound = false;
    }
    if (!isBound) {
      throw new ArtifactAdmissionError("composition_invalid", "composition manifest closure is not bound to this build result");
    }

    const verifiedAt = safeTime(this.clock);
    return {
      schemaVersion: 1,
      buildKey: expectedBuildKey as Sha256Digest,
      buildInput: expectedInput,
      image: {
        repository: statement.artifact.repository,
        digest: image.manifestDigest,
        reference: `${image.repository}@${image.manifestDigest}`,
        platformManifestDigest: image.platformManifestDigest,
        platform: statement.artifact.platform,
      },
      compositionManifest: {
        repository: statement.compositionManifest.repository,
        digest: composition.digest,
      },
      producerRevision: statement.producerRevision,
      resolvedModules: statement.resolvedModules,
      contractVersion: statement.contractVersion,
      issuedAt: statement.issuedAt,
      signerKeyId: signature.keyId,
      signature,
      verifiedAt,
      reachableLayerBytes: image.reachableLayerBytes,
      compositionManifestBytes: composition.size,
    };
  }

  /** Cache hits are rechecked against signer policy, persisted input and registry reachability. */
  async revalidate(artifact: VerifiedArtifact): Promise<VerifiedArtifact> {
    return this.verifyCandidate({ statement: statementFromVerifiedArtifact(artifact), signature: artifact.signature }, artifact.buildInput);
  }
}

export function statementFromVerifiedArtifact(artifact: VerifiedArtifact): BuilderArtifactStatement {
  return {
    schemaVersion: "praetorium.build-artifact/v1",
    buildKey: artifact.buildKey,
    artifact: {
      repository: artifact.image.repository,
      digest: artifact.image.digest,
      platformManifestDigest: artifact.image.platformManifestDigest,
      platform: artifact.image.platform,
    },
    compositionManifest: artifact.compositionManifest,
    producerRevision: artifact.producerRevision,
    resolvedModules: artifact.resolvedModules,
    contractVersion: "scriptorium-build/v1",
    issuedAt: artifact.issuedAt,
  };
}

function isRegistryUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "reason" in error &&
    (error.reason === "unavailable" || error.reason === "rate_limited");
}

export { isSha256Digest };
