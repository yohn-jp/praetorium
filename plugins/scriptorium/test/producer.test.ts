import { describe, expect, it } from "vitest";
import buildCatalogFixture from "./fixtures/build-catalog.v1.fixture.json" with { type: "json" };
import platformFixture from "./fixtures/platform.v1.fixture.json" with { type: "json" };
import {
  BuildCatalogSchema,
  QuiesceRequestSchema,
  QuiesceResultSchema,
  RuntimeAssignmentSchema,
  RuntimeMetadataSchema,
  RuntimeStatusSchema,
  assertQuiesceResultBoundToRequest,
} from "../src/producer.js";

describe("Scriptorium producer contract schemas", () => {
  it("accepts the synthetic versioned build catalog and platform observations", () => {
    expect(BuildCatalogSchema.parse(buildCatalogFixture).sourceDigest).toMatch(/^sha256:/u);
    expect(RuntimeMetadataSchema.parse(platformFixture.metadata).listener.port).toBe(3000);
    expect(RuntimeStatusSchema.parse(platformFixture.status).activity.pendingCheckpoints).toBe(0);
    expect(QuiesceRequestSchema.parse(platformFixture.quiesceRequest).runtimeEpoch).toBe(7);
    expect(QuiesceResultSchema.parse(platformFixture.quiesceResult).disposition).toBe("safe");
    expect(RuntimeAssignmentSchema.parse(platformFixture.assignment).repositoryId).toBe(123456789);
  });

  it("rejects absent versioned metadata, malformed immutable digests, and unknown fields", () => {
    expect(
      BuildCatalogSchema.safeParse({ ...buildCatalogFixture, contractVersion: "1" }).success,
    ).toBe(false);
    expect(
      BuildCatalogSchema.safeParse({ ...buildCatalogFixture, runtimeBaseDigest: "latest" }).success,
    ).toBe(false);
    expect(
      BuildCatalogSchema.safeParse({ ...buildCatalogFixture, sourceDigest: undefined }).success,
    ).toBe(false);
    expect(
      BuildCatalogSchema.safeParse({
        ...buildCatalogFixture,
        modules: buildCatalogFixture.modules.map((module) => module.id === "nlp"
          ? { ...module, artifactDigest: "latest" }
          : module),
      }).success,
    ).toBe(false);
    expect(
      BuildCatalogSchema.safeParse({ ...buildCatalogFixture, arbitraryEnv: { TOKEN: "secret" } })
        .success,
    ).toBe(false);
    expect(RuntimeMetadataSchema.safeParse({}).success).toBe(false);
  });

  it("refuses a safe quiesce result while authoring state remains unsafe", () => {
    expect(
      QuiesceResultSchema.safeParse({
        ...platformFixture.quiesceResult,
        pendingCheckpoints: 1,
      }).success,
    ).toBe(false);
    expect(
      QuiesceResultSchema.safeParse({
        ...platformFixture.quiesceResult,
        activeJobs: 1,
        restartableJobs: 0,
      }).success,
    ).toBe(false);
    expect(
      QuiesceResultSchema.safeParse({
        ...platformFixture.quiesceResult,
        activeJobs: 1,
        restartableJobs: 1,
      }).success,
    ).toBe(false);
  });

  it("binds quiesce observations to operation, instance, and runtime epoch", () => {
    expect(() =>
      assertQuiesceResultBoundToRequest(platformFixture.quiesceRequest, {
        ...platformFixture.quiesceResult,
        runtimeEpoch: 8,
      }),
    ).toThrow(/binding/u);
  });

  it("rejects noncanonical repository locators and environment-shaped assignments", () => {
    expect(
      RuntimeAssignmentSchema.safeParse({
        ...platformFixture.assignment,
        repositoryLocator: "https://github.com/example/work?token=exposed",
      }).success,
    ).toBe(false);
    expect(
      RuntimeAssignmentSchema.safeParse({
        ...platformFixture.assignment,
        environment: { SCRIPTORIUM_AUTH_TOKEN: "secret" },
      }).success,
    ).toBe(false);
    expect(
      RuntimeAssignmentSchema.safeParse({
        ...platformFixture.assignment,
        grantPolicy: undefined,
      }).success,
    ).toBe(false);
    expect(
      RuntimeAssignmentSchema.safeParse({
        ...platformFixture.assignment,
        controlServicePolicy: undefined,
      }).success,
    ).toBe(false);
    expect(
      QuiesceResultSchema.safeParse({
        ...platformFixture.quiesceResult,
        pendingCheckpoints: undefined,
      }).success,
    ).toBe(false);
  });
});

it("rejects safe quiesce received or observed after deadline", () => {
  const receiveTime = Date.parse(platformFixture.quiesceRequest.deadline);
  expect(() =>
    assertQuiesceResultBoundToRequest(
      platformFixture.quiesceRequest,
      platformFixture.quiesceResult,
      receiveTime,
    ),
  ).toThrow(/timeout/);
  expect(() =>
    assertQuiesceResultBoundToRequest(
      platformFixture.quiesceRequest,
      { ...platformFixture.quiesceResult, observedAt: platformFixture.quiesceRequest.deadline },
      receiveTime - 1,
    ),
  ).toThrow(/timeout/);
  expect(
    assertQuiesceResultBoundToRequest(
      platformFixture.quiesceRequest,
      platformFixture.quiesceResult,
      receiveTime - 1000,
    ).result.disposition,
  ).toBe("safe");
});
