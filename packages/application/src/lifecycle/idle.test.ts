import { describe, expect, it } from "vitest";
import { DEFAULT_IDLE_TIMEOUT_MS, IdleLifecycle, validateIdleTimeout } from "./idle.js";
import type { IdleObservation } from "./ports.js";

const now = Date.parse("2026-10-17T12:00:00.000Z");
const digest = `sha256:${"a".repeat(64)}`;

function observation(overrides: Partial<IdleObservation> = {}): IdleObservation {
  return {
    instanceId: "ins_01",
    repositoryId: 123456,
    lastMeaningfulActivityAt: new Date(now - DEFAULT_IDLE_TIMEOUT_MS).toISOString(),
    activeRequests: 0,
    activeJobs: 0,
    activeMutation: false,
    intendedStopped: false,
    runtimeState: "running",
    current: {
      instanceId: "ins_01",
      repositoryId: 123456,
      runtimeEpoch: 4,
      generation: 2,
      clusterId: "cluster-a",
      reservationId: "reservation-4",
      deployment: {
        revisionId: "rev-a",
        repositoryId: 123456,
        repositoryLocator: "https://github.com/owner/repository",
        defaultBranchPolicy: "repository-default",
        imageDigest: digest,
        compositionManifestDigest: digest,
        enabledModuleIds: ["core"],
        credentialBrokerLocator: "platform://credential-broker",
        grantPolicy: {
          issuer: "https://platform.example.test",
          jwksUrl: "https://platform.example.test/.well-known/jwks.json",
          audience: "https://instance.example.test",
        },
        controlServicePolicy: {
          issuer: "https://platform.example.test",
          jwksUrl: "https://platform.example.test/.well-known/jwks.json",
          audience: "praetorium-runtime-control",
        },
        hostname: "instance.example.test",
        resourceProfileId: "small",
      },
    },
    ...overrides,
  };
}

describe("IdleLifecycle", () => {
  it("uses the configurable 15-minute default and schedules only at the threshold", async () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(15 * 60_000);
    const value = observation();
    const scheduled: IdleObservation[] = [];
    const lifecycle = new IdleLifecycle({
      observations: { async observe() { return value; } },
      operations: {
        async createIdleStop(input) {
          scheduled.push(input);
          return "op-idle";
        },
      },
      now: () => now,
    });

    const decision = await lifecycle.evaluate("ins_01");

    expect(decision.status).toBe("scheduled");
    expect(scheduled).toEqual([value]);
  });

  it("does not count health or status polling as meaningful user activity", async () => {
    const oldMeaningfulActivity = new Date(now - DEFAULT_IDLE_TIMEOUT_MS - 5_000).toISOString();
    const lifecycle = new IdleLifecycle({
      observations: { async observe() { return observation({ lastMeaningfulActivityAt: oldMeaningfulActivity }); } },
      operations: { async createIdleStop() { return "op-idle"; } },
      now: () => now,
    });

    expect(await lifecycle.evaluate("ins_01")).toMatchObject({ status: "scheduled", operationId: "op-idle" });
  });

  it("keeps active requests, mutations, jobs, unknown activity, and user-stopped runtimes out of idle scheduling", async () => {
    const cases: readonly [Partial<IdleObservation>, string][] = [
      [{ activeRequests: 1 }, "authenticated_work_active"],
      [{ activeMutation: true }, "authenticated_work_active"],
      [{ activeJobs: 1 }, "authenticated_work_active"],
      [{ lastMeaningfulActivityAt: null }, "activity_time_unknown"],
      [{ intendedStopped: true }, "already_stopped_by_request"],
      [{ runtimeState: "unknown" }, "runtime_not_confirmed_running"],
      [{ current: null }, "no_current_runtime"],
      [{ activeJobs: -1 }, "activity_counts_invalid"],
    ];

    for (const [override, reason] of cases) {
      const lifecycle = new IdleLifecycle({
        observations: { async observe() { return observation(override); } },
        operations: { async createIdleStop() { return "unexpected"; } },
        now: () => now,
      });
      expect(await lifecycle.evaluate("ins_01")).toMatchObject({ status: "not-idle", reason });
    }
  });

  it("accepts positive integer timeout configuration only", () => {
    expect(validateIdleTimeout(undefined)).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(validateIdleTimeout(120_000)).toBe(120_000);
    expect(() => validateIdleTimeout(0)).toThrow(RangeError);
    expect(() => validateIdleTimeout(1.5)).toThrow(RangeError);
  });
});
