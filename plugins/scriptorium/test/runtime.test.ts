import { describe, expect, it } from "vitest";
import platformFixture from "./fixtures/platform.v1.fixture.json" with { type: "json" };
import {
  assertRuntimeStatusBoundToAssignment,
  runtimeAuthenticationPolicy,
  runtimeApplicationRequirements,
} from "../src/runtime.js";

describe("Scriptorium runtime adaptation", () => {
  it("maps only producer-declared runtime values", () => {
    expect(runtimeApplicationRequirements(platformFixture.metadata)).toEqual({
      httpPort: 3000,
      livenessPath: "/api/health",
      readinessPath: "/api/ready",
      metadataPath: "/api/platform/v1/metadata",
      shutdownPath: "/api/platform/v1/shutdown",
      shutdownTimeoutSeconds: 30,
      platformControlPaths: {
        status: "/api/platform/v1/status",
        quiesce: "/api/platform/v1/quiesce",
        resume: "/api/platform/v1/resume",
      },
    });
  });

  it("passes through the declared port instead of substituting the old Loom port", () => {
    expect(runtimeApplicationRequirements({
      ...platformFixture.metadata,
      listener: { port: 3847 },
    }).httpPort).toBe(3847);
  });

  it("exposes separate expected grant and control-service verifier policies", () => {
    expect(runtimeAuthenticationPolicy(platformFixture.assignment)).toEqual({
      grantVerifier: platformFixture.assignment.grantPolicy,
      controlServiceVerifier: platformFixture.assignment.controlServicePolicy,
    });
  });

  it("binds status identity, epoch, image/composition metadata, and modules to the assignment", () => {
    expect(assertRuntimeStatusBoundToAssignment(platformFixture.assignment, platformFixture.status).ready).toBe(true);
    expect(() => assertRuntimeStatusBoundToAssignment(platformFixture.assignment, {
      ...platformFixture.status,
      runtimeEpoch: 8,
    })).toThrow(/assignment/u);
    expect(() => assertRuntimeStatusBoundToAssignment(platformFixture.assignment, {
      ...platformFixture.status,
      enabledModuleIds: ["nlp"],
    })).toThrow(/assignment/u);
    expect(() => assertRuntimeStatusBoundToAssignment(platformFixture.assignment, {
      ...platformFixture.status,
      imageDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    })).toThrow(/assignment/u);
    expect(() => assertRuntimeStatusBoundToAssignment(platformFixture.assignment, {
      ...platformFixture.status,
      repositoryId: 987654321,
    })).toThrow(/assignment/u);
  });
});
