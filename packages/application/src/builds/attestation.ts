import {
  BuilderArtifactStatementSchema,
  BuilderSignatureSchema,
} from "@praetorium/contracts";
import type {
  BuildAttestor,
  BuildCandidateVerifier,
  BuilderSigner,
  SignedBuildCandidate,
} from "./types.js";

export class BuildAttestationError extends Error {
  constructor(readonly retryable = false) {
    super("Build candidate evidence did not match the claimed immutable input");
    this.name = "BuildAttestationError";
  }
}

/**
 * Verifies registry bytes and composition evidence before using the operator's
 * builder key. The signer never receives a statement supplied by the worker.
 */
export class VerifiedBuildAttestor implements BuildAttestor {
  constructor(
    private readonly verifier: BuildCandidateVerifier,
    private readonly signer: BuilderSigner,
  ) {}

  async attest(input: Parameters<BuildAttestor["attest"]>[0]): Promise<SignedBuildCandidate> {
    await input.beforeEffect();
    const statement = BuilderArtifactStatementSchema.parse(await this.verifier.verify({
      buildKey: input.buildKey,
      expected: input.expected,
      candidate: input.candidate,
      signal: input.signal,
    }));
    assertStatementBinding(statement, input);
    await input.beforeEffect();
    const signature = BuilderSignatureSchema.parse(await this.signer.sign(statement));
    return {
      ...input.candidate,
      statement,
      signature,
    };
  }
}

function assertStatementBinding(
  statement: ReturnType<typeof BuilderArtifactStatementSchema.parse>,
  input: Parameters<BuildAttestor["attest"]>[0],
): void {
  const separator = input.candidate.candidateRef.lastIndexOf("@");
  const imageReference = separator > 0 ? input.candidate.candidateRef.slice(0, separator) : "";
  const registrySeparator = imageReference.indexOf("/");
  const registryHost = registrySeparator > 0 ? imageReference.slice(0, registrySeparator) : "";
  const repository = registrySeparator > 0 ? imageReference.slice(registrySeparator + 1) : "";
  const refDigest = separator > 0 ? input.candidate.candidateRef.slice(separator + 1) : "";
  const expectedModules = [...input.expected.resolvedModules].sort((a, b) => a.id.localeCompare(b.id));
  const statementModules = statement.resolvedModules;
  if (
    statement.buildKey !== input.buildKey ||
    !registryHost ||
    statement.artifact.repository !== repository ||
    input.candidate.candidateRef !== `${registryHost}/${statement.artifact.repository}@${input.candidate.manifestDigest}` ||
    statement.artifact.digest !== input.candidate.manifestDigest ||
    refDigest !== input.candidate.manifestDigest ||
    statement.compositionManifest.repository !== input.candidate.compositionManifest.repository ||
    statement.compositionManifest.digest !== input.candidate.compositionManifest.digest ||
    statement.artifact.platform !== input.expected.platform ||
    statement.producerRevision !== input.expected.producerRevision ||
    statement.contractVersion !== input.expected.contractVersion ||
    JSON.stringify(statementModules) !== JSON.stringify(expectedModules)
  ) {
    throw new BuildAttestationError();
  }
}
