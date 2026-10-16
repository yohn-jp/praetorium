import { expect, it } from "vitest";
import { buildKey } from "./build.js";
import { assertBuildReportBindings } from "./build-queue.js";
it("rejects valid-shaped attestations attached to another build or candidate", async () => {
  const d = `sha256:${"a".repeat(64)}`,
    other = `sha256:${"b".repeat(64)}`;
  const input = {
    contractVersion: "scriptorium-build/v1" as const,
    producerRevision: "a".repeat(40),
    runtimeBaseDigest: d,
    buildKitDigest: d,
    recipeDigest: d,
    sourceDigest: d,
    lockDigest: d,
    requestedModules: [],
    resolvedModules: [],
    platform: "linux/amd64" as const,
    options: {},
  };
  const key = await buildKey(input),
    compositionManifest = { repository: "test/composition", digest: d };
  const statement = {
    schemaVersion: "praetorium.build-artifact/v1",
    buildKey: key,
    artifact: {
      repository: "test/image",
      digest: d,
      platformManifestDigest: d,
      platform: input.platform,
    },
    compositionManifest,
    producerRevision: input.producerRevision,
    resolvedModules: [],
    contractVersion: input.contractVersion,
    issuedAt: "2026-10-17T00:00:00Z",
  };
  const result = {
    kind: "succeeded",
    candidateRef: `ghcr.io/test/image@${d}`,
    manifestDigest: d,
    compositionManifest,
    statement,
    signature: { algorithm: "Ed25519", keyId: "test", signature: "YQ==" },
  };
  const report = {
    buildId: "b",
    buildKey: key,
    attemptId: "a",
    leaseEpoch: 1,
    leaseToken: "x".repeat(32),
    workerId: "w",
    sequence: 1,
    result,
  };
  const approved = { registryHost: "ghcr.io", repository: "test/image" };
  await expect(assertBuildReportBindings(input, report, approved)).resolves.toBeUndefined();
  for (const changed of [
    { buildKey: other },
    { result: { ...result, manifestDigest: other } },
    { result: { ...result, statement: { ...statement, buildKey: other } } },
    { result: { ...result, candidateRef: `ghcr.io/other/image@${d}` } },
    { result: { ...result, compositionManifest: { ...compositionManifest, digest: other } } },
  ])
    await expect(
      assertBuildReportBindings(input, { ...report, ...changed }, approved),
    ).rejects.toThrow();
});
