/* Owned synthetic fixtures shared by unit and local browser UI checks. */
import type { PortalRepositoryDashboard, PortalRepositoryList, PortalOperation } from "./types.js";

export const summary: PortalRepositoryDashboard["repository"] = {
  repositoryId: "123456789",
  fullName: "owner/project",
  installation: "active",
  permission: "maintain",
  instance: { state: "ready", instanceId: "ins_01", retryable: false, reason: null },
  currentImageDigest: "sha256:current-image",
  desiredImageDigest: "sha256:current-image",
  operation: null,
};

export const operation: PortalOperation = {
  operationId: "op_01",
  kind: "build",
  state: "failed",
  progressPercent: 73,
  message: "Build stopped before deployment.",
  error: "producer rejected this module selection",
  retryable: true,
};

export const dashboard: PortalRepositoryDashboard = {
  repository: summary,
  generation: 4,
  releasePolicy: { kind: "stable" },
  current: {
    releaseId: "rel_01",
    releaseLabel: "Stable 1.2",
    baseImageDigest: "sha256:base-image",
    composedImageDigest: "sha256:current-image",
    resourceProfileId: "balanced",
    requestedModules: ["editor"],
    includedModules: ["editor", "search"],
    resources: {
      cpuMilli: 1000,
      memoryMiB: 2048,
      ephemeralStorageMiB: 1024,
    },
  },
  desired: {
    releaseId: "rel_01",
    releaseLabel: "Stable 1.2",
    baseImageDigest: "sha256:base-image",
    composedImageDigest: "sha256:current-image",
    resourceProfileId: "balanced",
    requestedModules: ["editor"],
    includedModules: ["editor", "search"],
    resources: {
      cpuMilli: 1000,
      memoryMiB: 2048,
      ephemeralStorageMiB: 1024,
    },
  },
  preview: {
    state: "valid",
    releasePolicy: "stable",
    releaseId: "rel_01",
    requestedModules: ["editor"],
    resourceProfileId: "balanced",
    includedModules: ["editor", "search"],
    unsupportedReasons: [],
    resources: {
      cpuMilli: 1000,
      memoryMiB: 2048,
      ephemeralStorageMiB: 1024,
    },
  },
  build: {
    buildId: "build_01",
    buildKey: "sha256:build-key",
    status: "failed",
    stage: "building",
    progressPercent: 73,
    errorCode: "PRODUCER_REJECTED",
    updatedAt: 1_800_000_000_000,
  },
  approvedReleases: [
    {
      releaseId: "rel_01",
      label: "Stable 1.2",
      imageDigest: "sha256:base-image",
    },
  ],
  modules: [
    { moduleId: "editor", label: "Editor", version: "2.0.0", artifactDigest: "sha256:editor" },
    { moduleId: "search", label: "Search", version: "1.4.0", artifactDigest: "sha256:search" },
  ],
  resourceProfiles: [
    {
      profileId: "balanced",
      label: "Balanced",
      resources: {
        cpuMilli: 1000,
        memoryMiB: 2048,
        ephemeralStorageMiB: 1024,
      },
    },
  ],
  resourceLimits: {
    cpuMilli: 4000,
    memoryMiB: 8192,
    ephemeralStorageMiB: 8192,
  },
  operations: [operation],
  canConfigure: true,
};

export const repositoryList: PortalRepositoryList = {
  githubApp: { installationState: "active", message: "GitHub App installation is active." },
  repositories: [summary],
};
