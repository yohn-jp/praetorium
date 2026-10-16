import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuilderArtifactStatement } from "@praetorium/contracts";
import {
  BuilderSignerConfigurationError,
  canonicalBuilderStatement,
  loadFileBuilderSigner,
} from "./file-builder-signer.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-builder-signer-test-"));
  roots.push(root);
  return root;
}

const statement: BuilderArtifactStatement = {
  schemaVersion: "praetorium.build-artifact/v1",
  buildKey: `sha256:${"1".repeat(64)}`,
  artifact: {
    repository: "registry.example/praetorium/candidates",
    digest: `sha256:${"2".repeat(64)}`,
    platformManifestDigest: `sha256:${"3".repeat(64)}`,
    platform: "linux/amd64",
  },
  compositionManifest: {
    repository: "registry.example/praetorium/compositions",
    digest: `sha256:${"4".repeat(64)}`,
  },
  producerRevision: "a".repeat(40),
  resolvedModules: [],
  contractVersion: "scriptorium-build/v1",
  issuedAt: "2026-10-17T00:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Ed25519BuilderSigner", () => {
  it("loads a private owner-only PKCS8 file and signs canonical statement bytes", async () => {
    const root = await makeRoot();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPath = path.join(root, "builder-key.pem");
    await writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), {
      mode: 0o600,
    });
    const signer = await loadFileBuilderSigner({ privateKeyPath, keyId: "builder-key-v1" });
    const signature = await signer.sign(statement);
    expect(signature.algorithm).toBe("Ed25519");
    expect(signature.keyId).toBe("builder-key-v1");
    expect(
      cryptoVerify(
        null,
        canonicalBuilderStatement(statement),
        publicKey,
        Buffer.from(signature.signature, "base64"),
      ),
    ).toBe(true);
  });

  it("rejects readable, linked, malformed, and non-Ed25519 key files", async () => {
    const root = await makeRoot();
    const generated = generateKeyPairSync("ed25519");
    const privateKeyPath = path.join(root, "builder-key.pem");
    await writeFile(privateKeyPath, generated.privateKey.export({ format: "pem", type: "pkcs8" }), {
      mode: 0o600,
    });
    await chmod(privateKeyPath, 0o644);
    await expect(
      loadFileBuilderSigner({ privateKeyPath, keyId: "builder-key-v1" }),
    ).rejects.toBeInstanceOf(BuilderSignerConfigurationError);
    await chmod(privateKeyPath, 0o600);

    const linkedPath = path.join(root, "linked-key.pem");
    await symlink(privateKeyPath, linkedPath);
    await expect(
      loadFileBuilderSigner({ privateKeyPath: linkedPath, keyId: "builder-key-v1" }),
    ).rejects.toBeInstanceOf(BuilderSignerConfigurationError);

    await writeFile(privateKeyPath, "not a private key", { mode: 0o600 });
    await expect(
      loadFileBuilderSigner({ privateKeyPath, keyId: "builder-key-v1" }),
    ).rejects.toBeInstanceOf(BuilderSignerConfigurationError);
  });
});
