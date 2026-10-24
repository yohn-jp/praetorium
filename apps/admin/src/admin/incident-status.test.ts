import { describe, expect, it } from "vitest";
import type { SourceBuildSummary } from "@praetorium/contracts";
import type { ConsoleRelease } from "./view-model.js";
import { activeSourceFailures, activeReleaseFailures, prioritySourceBuild } from "./incident-status.js";

function job(tag: string, state: SourceBuildSummary["state"], sourceId = "scriptorium"): SourceBuildSummary {
  return {
    id: "sr_00000000-0000-4000-a000-000000000001",
    sourceId, releaseId: 100, tag, commit: "a".repeat(40),
    version: tag.replace(/^v/u, ""), state, attempt: 1, revision: 0,
    error: state === "failed" ? "SOURCE_BUILD_FAILED" : null,
    retryable: state === "failed", admittedReleaseId: state === "admitted" ? "rel_new" : null,
  };
}
function candidate(version: string, state: string, failureCode: string | null = null): ConsoleRelease {
  return {
    release: {id:"rel_"+version,version,imageDigest:"sha256:"+"b".repeat(64),
      status:state === "complete" ? "available" : "candidate",createdAt:"2026-10-24T00:00:00Z"},
    workflow: {workflow:{state,revision:3,failureCode,attempts:1,nextAttemptAt:null},
      build:null},
  };
}

describe("active incidents are distinct from immutable failure history", () => {
  it("suppresses older failed Source builds after a newer admitted build of the same source", () => {
    const jobs=[job("v0.3.3","failed"),job("v0.3.2","failed"),job("v0.3.4","admitted")];
    expect(activeSourceFailures(jobs)).toEqual([]);
    expect(prioritySourceBuild(jobs)?.tag).toBe("v0.3.4");
  });

  it("does not hide an actual failure when a newer build is only queued or failed", () => {
    const jobs=[job("v0.3.3","failed"),job("v0.3.4","queued")];
    expect(activeSourceFailures(jobs).map(j=>j.tag)).toEqual(["v0.3.3"]);
    const unrelated=[job("v0.3.3","failed","other"),job("v0.3.4","admitted")];
    expect(activeSourceFailures(unrelated)).toHaveLength(1);
  });

  it("does not mistake Source admission for platform Stable availability", () => {
    const releases=[candidate("0.1.0-hosted.20261018","blocked","legacy_discarded"),
      candidate("0.3.4","canary_cleanup")];
    expect(activeReleaseFailures(releases)).toEqual([]);
    expect(releases[1]?.release.status).toBe("candidate");
  });

  it("keeps a current blocked or diagnosably stuck Canary release visible", () => {
    const releases=[candidate("0.1.0-hosted.20261018","blocked","legacy_discarded"),
      candidate("0.3.4","canary_cleanup","canary_stop_blocked")];
    expect(activeReleaseFailures(releases)).toEqual([releases[1]]);
    expect(activeReleaseFailures([candidate("0.3.4","blocked","canary_build_failed")])).toHaveLength(1);
  });

  it("never uses malformed or lower versions to supersede real failures", () => {
    const bad=[job("v0.3.4","failed"),job("experimental","admitted")];
    expect(activeSourceFailures(bad)).toHaveLength(1);
    expect(activeSourceFailures([job("v0.3.4","failed"),job("v0.3.3","admitted")])).toHaveLength(1);
  });
});
