import { expect, it, vi } from "vitest";
import { SourceProducerResultSchema } from "@praetorium/contracts";
import type { SourceJob } from "./source-release-builds.js";
import { progressProducedSourceReleases } from "./source-release-progression.js";
import catalog from "../../../plugins/scriptorium/test/fixtures/build-catalog.v1.fixture.json" with { type: "json" };
import platform from "../../../plugins/scriptorium/test/fixtures/platform.v1.fixture.json" with { type: "json" };

function job(index: number): SourceJob & { result_json: string } {
  const id = "sr_11111111-1111-4111-8111-" + String(index).padStart(12, "0");
  const proof = SourceProducerResultSchema.parse({
    statement: {
      schemaVersion: 3, jobId: id, githubReleaseId: index, sourceId: "scriptorium",
      sourceRepository: "yohn-jp/scriptorium", sourceTag: "v0.1.0", sourceRevision: catalog.producerRevision,
      releaseVersion: "0.1.0", imageRepository: "ghcr.io/yohn-jp/praetorium/scriptorium-producer",
      runtimeBaseDigest: catalog.runtimeBaseDigest, buildKitDigest: catalog.buildKitDigest,
      nodeImage:"docker.io/library/node@sha256:"+"a".repeat(64),buildEnvironmentDigest:"sha256:"+"b".repeat(64),
      resolverDigest:"sha256:"+"c".repeat(64),resolverProvenanceDigest:"sha256:"+"d".repeat(64),
      catalogDigest: "sha256:" + "a".repeat(64), runtimeMetadataDigest: "sha256:" + "b".repeat(64),
    },
    signature: { algorithm: "Ed25519", keyId: "unit-fixture", signature: "unit-fixture" },
    resolver:{producerRevision:catalog.producerRevision,resolverRevision:"sha256:"+"c".repeat(64),contractVersion:"scriptorium-build/v1",provenanceDigest:"sha256:"+"d".repeat(64)},
    catalog, runtimeMetadata: platform.metadata,
  });
  return {
    job_id: id, source_id: "scriptorium", github_release_id: index, source_repository: "yohn-jp/scriptorium",
    source_tag: "v0.1.0", source_revision: catalog.producerRevision, release_version: "0.1.0", actor_id: "71",
    state: "produced", attempt: 1, revision: 1, admission_attempt: 1, next_attempt_at: 301_000,
    lease_worker: null, lease_token: null, lease_epoch: 1, lease_expires_at: null,
    result_json: JSON.stringify(proof), failure_code: null, admitted_release_id: null, created_at: 1000, updated_at: 1000,
  };
}

it("leaves later jobs unclaimed while OCI is slow, then moves past five retrying rows", async () => {
  const jobs = Array.from({ length: 6 }, (_, i) => job(i + 1));
  let finishFirst: (() => void) | undefined;
  const slow = new Promise<void>(resolve => { finishFirst = resolve; });
  const queue = {
    claimProduced: vi.fn(async () => {
      const next = jobs.shift();
      return next ? [next] : [];
    }),
    markAdmitted: vi.fn(async () => true),
    rejectProduced: vi.fn(async () => true),
    deferProduced: vi.fn(async () => true),
  };
  const admit = vi.fn(async (input: SourceJob) => {
    if (input.github_release_id === 1) await slow;
    return input.github_release_id <= 5
      ? { kind: "retry" as const, reason: "unit fixture provider unavailable" }
      : { kind: "denied" as const, reason: "unit fixture completed verification" };
  });
  const run = progressProducedSourceReleases({ queue, admissionLeaseMs: 390_000, admit, progressAdmitted: vi.fn() });
  await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce());
  expect(queue.claimProduced).toHaveBeenCalledTimes(1);
  expect(jobs).toHaveLength(5);
  finishFirst!();
  await run;
  expect(admit).toHaveBeenCalledTimes(6);
  expect(queue.deferProduced).toHaveBeenCalledTimes(5);
  expect(queue.rejectProduced).toHaveBeenCalledWith(expect.any(String), "ADMISSION_DENIED", 1);
  for (const args of queue.claimProduced.mock.calls) expect(args).toEqual([1, 390_000]);
});
