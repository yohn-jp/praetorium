import { describe, expect, it } from "vitest";
import {
  builderStatementBytes,
  encodeBase64,
  OperatorBuilderSignatureVerifier,
  type BuilderArtifactStatement,
} from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}` as const;

async function signedStatement() {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" } as AlgorithmIdentifier, true, ["sign", "verify"]);
  const rawPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const keyId = "operator-primary-2026";
  const statement: BuilderArtifactStatement = {
    schemaVersion: "praetorium.build-artifact/v1",
    buildKey: digest,
    artifact: {
      repository: "praetorium/derived",
      digest,
      platformManifestDigest: digest,
      platform: "linux/amd64",
    },
    compositionManifest: { repository: "praetorium/derived", digest },
    producerRevision: "b".repeat(40),
    resolvedModules: [],
    contractVersion: "scriptorium-build/v1",
    issuedAt: new Date().toISOString(),
  };
  const signatureBytes = await crypto.subtle.sign(
    { name: "Ed25519" } as AlgorithmIdentifier,
    keyPair.privateKey,
    builderStatementBytes(statement),
  );
  return {
    statement,
    signature: { algorithm: "Ed25519" as const, keyId, signature: encodeBase64(new Uint8Array(signatureBytes)) },
    key: { keyId, publicKeyBase64: encodeBase64(rawPublicKey) },
  };
}

describe("operator builder signatures", () => {
  it("verifies an artifact statement using only the pinned operator key", async () => {
    const signed = await signedStatement();
    const verifier = new OperatorBuilderSignatureVerifier([signed.key]);

    await expect(verifier.verify(signed.statement, signed.signature)).resolves.toMatchObject({
      verified: true,
      keyId: signed.key.keyId,
    });
  });

  it("rejects modified output identity and revoked keys", async () => {
    const signed = await signedStatement();
    const verifier = new OperatorBuilderSignatureVerifier([signed.key]);
    const modified = {
      ...signed.statement,
      artifact: { ...signed.statement.artifact, digest: `sha256:${"c".repeat(64)}` as const },
    };
    const revoked = new OperatorBuilderSignatureVerifier([{ ...signed.key, revoked: true }]);

    await expect(verifier.verify(modified, signed.signature)).resolves.toMatchObject({ verified: false });
    await expect(revoked.verify(signed.statement, signed.signature)).resolves.toMatchObject({ verified: false });
  });

  it("rejects producer CI identity fields from the signed schema", async () => {
    const signed = await signedStatement();
    const invalid = { ...signed.statement, repositoryId: 123, actorId: "user" };
    const verifier = new OperatorBuilderSignatureVerifier([signed.key]);

    await expect(verifier.verify(invalid as BuilderArtifactStatement, signed.signature)).resolves.toMatchObject({
      verified: false,
    });
  });
});
