import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuilderArtifactStatement } from "@praetorium/contracts";
import { canonicalBuilderStatement, loadFileBuilderSigner } from "@praetorium/application/builds";
import { builderStatementBytes, OperatorBuilderSignatureVerifier } from "@praetorium/ghcr";

const directories: string[] = [];
const statement: BuilderArtifactStatement = {
  schemaVersion: "praetorium.build-artifact/v1",
  buildKey: `sha256:${"1".repeat(64)}`,
  artifact: {
    repository: "owner/candidates",
    digest: `sha256:${"2".repeat(64)}`,
    platformManifestDigest: `sha256:${"3".repeat(64)}`,
    platform: "linux/amd64",
  },
  compositionManifest: { repository: "owner/compositions", digest: `sha256:${"4".repeat(64)}` },
  producerRevision: "a".repeat(40),
  resolvedModules: [],
  contractVersion: "scriptorium-build/v1",
  issuedAt: "2026-10-17T00:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("builder signer interoperability", () => {
  it("produces the exact canonical bytes and Ed25519 signature accepted by the registry verifier", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "praetorium-builder-signing-compat-test-"));
    directories.push(directory);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyFile = path.join(directory, "builder-key.pem");
    await writeFile(privateKeyFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    const signer = await loadFileBuilderSigner({ privateKeyPath: privateKeyFile, keyId: "builder-key-v1" });
    const signature = await signer.sign(statement);
    const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const verifier = new OperatorBuilderSignatureVerifier([
      { keyId: signature.keyId, publicKeyBase64: rawPublicKey.toString("base64") },
    ], () => Date.parse(statement.issuedAt));

    expect(Buffer.from(builderStatementBytes(statement))).toEqual(canonicalBuilderStatement(statement));
    await expect(verifier.verify(statement, signature)).resolves.toMatchObject({
      verified: true,
      keyId: signature.keyId,
    });
  });
});
