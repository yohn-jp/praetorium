import { describe, expect, it, vi } from "vitest";
import { buildKey } from "@praetorium/contracts";
import type { BuildInput, BuilderArtifactStatement } from "@praetorium/contracts";
import { BuildAttestationError, VerifiedBuildAttestor } from "./attestation.js";

const input: BuildInput = {
  contractVersion: "scriptorium-build/v1",
  producerRevision: "a".repeat(40),
  runtimeBaseDigest: `sha256:${"1".repeat(64)}`,
  buildKitDigest: `sha256:${"2".repeat(64)}`,
  recipeDigest: `sha256:${"3".repeat(64)}`,
  sourceDigest: `sha256:${"4".repeat(64)}`,
  lockDigest: `sha256:${"5".repeat(64)}`,
  requestedModules: [],
  resolvedModules: [],
  platform: "linux/amd64",
  options: {},
};
const manifestDigest = `sha256:${"6".repeat(64)}`;
const candidate = {
  candidateRef: `registry.example/praetorium/candidates@${manifestDigest}`,
  manifestDigest,
  compositionManifest: { repository: "praetorium/compositions", digest: `sha256:${"7".repeat(64)}` },
};

function statement(key: string): BuilderArtifactStatement {
  return {
    schemaVersion: "praetorium.build-artifact/v1",
    buildKey: key,
    artifact: {
      repository: "praetorium/candidates",
      digest: manifestDigest,
      platformManifestDigest: `sha256:${"8".repeat(64)}`,
      platform: "linux/amd64",
    },
    compositionManifest: candidate.compositionManifest,
    producerRevision: input.producerRevision,
    resolvedModules: [],
    contractVersion: input.contractVersion,
    issuedAt: "2026-10-17T00:00:00.000Z",
  };
}

describe("VerifiedBuildAttestor", () => {
  it("signs only verifier-produced evidence bound to the immutable input and candidate", async () => {
    const key = await buildKey(input);
    const evidence = statement(key);
    const verifier = { verify: vi.fn(async () => evidence) };
    const signer = { sign: vi.fn(async () => ({ algorithm: "Ed25519" as const, keyId: "builder-1", signature: "c2ln" })) };
    const beforeEffect = vi.fn(async () => undefined);
    const signal = new AbortController().signal;
    const attestor = new VerifiedBuildAttestor(verifier, signer);
    const result = await attestor.attest({ buildKey: key, expected: input, candidate, signal, beforeEffect });

    expect(verifier.verify).toHaveBeenCalledWith({ buildKey: key, expected: input, candidate, signal });
    expect(signer.sign).toHaveBeenCalledWith(evidence);
    expect(beforeEffect).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ...candidate, statement: evidence, signature: { algorithm: "Ed25519", keyId: "builder-1", signature: "c2ln" } });
  });

  it("does not sign a statement whose artifact, composition, modules, platform, or build key is mismatched", async () => {
    const key = await buildKey(input);
    const invalid = statement(`sha256:${"f".repeat(64)}`);
    const verifier = { verify: vi.fn(async () => invalid) };
    const signer = { sign: vi.fn(async () => ({ algorithm: "Ed25519" as const, keyId: "builder-1", signature: "c2ln" })) };
    const attestor = new VerifiedBuildAttestor(verifier, signer);
    await expect(attestor.attest({ buildKey: key, expected: input, candidate, signal: new AbortController().signal, beforeEffect: async () => undefined }))
      .rejects.toBeInstanceOf(BuildAttestationError);
    expect(signer.sign).not.toHaveBeenCalled();
  });

  it("passes attempt cancellation to verification and rechecks the fence before signing", async () => {
    const key = await buildKey(input);
    const controller = new AbortController();
    const evidence = statement(key);
    const verifier = {
      verify: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
        expect(signal).toBe(controller.signal);
        controller.abort(new Error("attempt canceled"));
        return evidence;
      }),
    };
    const signer = { sign: vi.fn(async () => ({ algorithm: "Ed25519" as const, keyId: "builder-1", signature: "c2ln" })) };
    const beforeEffect = vi.fn(async () => {
      if (controller.signal.aborted) throw controller.signal.reason;
    });
    const attestor = new VerifiedBuildAttestor(verifier, signer);

    await expect(attestor.attest({
      buildKey: key,
      expected: input,
      candidate,
      signal: controller.signal,
      beforeEffect,
    })).rejects.toThrow("attempt canceled");
    expect(signer.sign).not.toHaveBeenCalled();
  });
});
