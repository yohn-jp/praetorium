import { describe, expect, it } from "vitest";
import { readBuildWorkerConfig } from "../src/config.js";

const environment: NodeJS.ProcessEnv = {
  PRAETORIUM_BUILD_WORKER_ID: "worker-1",
  PRAETORIUM_CONTROL_PLANE_URL: "https://control.example",
  PRAETORIUM_BUILD_SERVICE_TOKEN_FILE: "/run/secrets/build-service-token",
  PRAETORIUM_BUILD_SIGNING_KEY_FILE: "/run/secrets/builder-key.pem",
  PRAETORIUM_BUILD_SIGNING_KEY_ID: "builder-key-v1",
  PRAETORIUM_BUILD_REGISTRY_URL: "https://ghcr.io",
  PRAETORIUM_BUILD_COMPOSITION_REPOSITORY: "praetorium/compositions",
  PRAETORIUM_BUILD_MAX_IMAGE_LAYER_BYTES: "17179869184",
  PRAETORIUM_BUILD_MAX_IMAGE_VERIFICATION_MS: "300000",
  PRAETORIUM_BUILD_MAX_REGISTRY_REQUEST_MS: "30000",
  PRAETORIUM_BUILDKIT_ADDRESS: "tcp://buildkit.internal:1234",
  PRAETORIUM_BUILDKIT_TLS_SERVER_NAME: "buildkit.internal",
  PRAETORIUM_BUILDKIT_TLS_CA_FILE: "/run/secrets/buildkit-ca.pem",
  PRAETORIUM_BUILDKIT_TLS_CERT_FILE: "/run/secrets/build-worker.pem",
  PRAETORIUM_BUILDKIT_TLS_KEY_FILE: "/run/secrets/build-worker-key.pem",
  PRAETORIUM_BUILDKIT_BUILDCTL_PATH: "/usr/bin/buildctl",
  PRAETORIUM_BUILDKIT_FRONTEND_REPOSITORY: "registry.example/praetorium/buildkit",
  PRAETORIUM_BUILDKIT_OUTPUT_REPOSITORY: "registry.example/praetorium/candidates",
  PRAETORIUM_BUILDKIT_DOCKER_CONFIG_DIRECTORY: "/run/secrets/buildkit-registry-auth",
  PRAETORIUM_BUILDKIT_TEMPORARY_DIRECTORY: "/var/lib/praetorium/build-worker/tmp",
  PRAETORIUM_BUILDKIT_SAFE_PATH: "/usr/bin:/bin",
};

describe("Build worker startup configuration", () => {
  it("loads bounded limits and fixed file paths from explicit operator configuration", () => {
    expect(readBuildWorkerConfig(environment)).toMatchObject({
      workerId: "worker-1",
      controlPlaneUrl: "https://control.example",
      leaseSeconds: 120,
      heartbeatIntervalMs: 15_000,
      registryUrl: "https://ghcr.io",
      registryAllowInsecureLoopback: false,
      registryAllowAnonymousLoopbackPublish: false,
      compositionRepository: "praetorium/compositions",
      maxImageLayerBytes: 17_179_869_184,
      maxImageVerificationMs: 300_000,
      maxRegistryRequestMs: 30_000,
      buildKit: {
        address: "tcp://buildkit.internal:1234",
        allowInsecureLoopbackRegistry: false,
        maxBuildInputBytes: 65_536,
        maxProgressBytes: 8 * 1024 * 1024,
      },
    });
  });

  it("rejects HTTP control URLs, relative secret paths, unbounded values, and a heartbeat longer than the lease", () => {
    expect(() =>
      readBuildWorkerConfig({
        ...environment,
        PRAETORIUM_CONTROL_PLANE_URL: "http://control.example",
      }),
    ).toThrow();
    expect(() =>
      readBuildWorkerConfig({ ...environment, PRAETORIUM_BUILD_SIGNING_KEY_FILE: "key.pem" }),
    ).toThrow();
    expect(() =>
      readBuildWorkerConfig({
        ...environment,
        PRAETORIUM_BUILDKIT_MAX_PROGRESS_BYTES: "999999999",
      }),
    ).toThrow();
    expect(() =>
      readBuildWorkerConfig({
        ...environment,
        PRAETORIUM_BUILD_REGISTRY_URL: "http://registry.example",
      }),
    ).toThrow();
    expect(() =>
      readBuildWorkerConfig({
        ...environment,
        PRAETORIUM_BUILD_COMPOSITION_REPOSITORY: "../praetorium/compositions",
      }),
    ).toThrow();
    expect(() =>
      readBuildWorkerConfig({ ...environment, PRAETORIUM_BUILD_MAX_IMAGE_LAYER_BYTES: "0" }),
    ).toThrow();
    expect(() =>
      readBuildWorkerConfig({
        ...environment,
        PRAETORIUM_BUILD_MAX_IMAGE_VERIFICATION_MS: "999999999",
      }),
    ).toThrow();
    expect(() =>
      readBuildWorkerConfig({ ...environment, PRAETORIUM_BUILD_MAX_REGISTRY_REQUEST_MS: "0" }),
    ).toThrow();
    expect(() =>
      readBuildWorkerConfig({
        ...environment,
        PRAETORIUM_BUILD_LEASE_SECONDS: "15",
        PRAETORIUM_BUILD_HEARTBEAT_MS: "15000",
      }),
    ).toThrow();
  });

  it("allows operator-owned HTTPS registries and explicit HTTP loopback acceptance only", () => {
    expect(
      readBuildWorkerConfig({
        ...environment,
        PRAETORIUM_BUILD_REGISTRY_URL: "https://registry.internal.example:5443",
      }).registryUrl,
    ).toBe("https://registry.internal.example:5443");
    expect(
      readBuildWorkerConfig({
        ...environment,
        PRAETORIUM_BUILD_REGISTRY_URL: "http://127.0.0.1:39567",
        PRAETORIUM_BUILD_ALLOW_INSECURE_LOOPBACK_REGISTRY: "1",
      }),
    ).toMatchObject({
      registryUrl: "http://127.0.0.1:39567",
      registryAllowInsecureLoopback: true,
      registryAllowAnonymousLoopbackPublish: true,
      buildKit: { allowInsecureLoopbackRegistry: true },
    });
    expect(() =>
      readBuildWorkerConfig({
        ...environment,
        PRAETORIUM_BUILD_REGISTRY_URL: "http://127.0.0.1:39567",
      }),
    ).toThrow();
    expect(() =>
      readBuildWorkerConfig({
        ...environment,
        PRAETORIUM_BUILD_REGISTRY_URL: "http://registry.internal.example:39567",
        PRAETORIUM_BUILD_ALLOW_INSECURE_LOOPBACK_REGISTRY: "1",
      }),
    ).toThrow();
    expect(() =>
      readBuildWorkerConfig({
        ...environment,
        PRAETORIUM_BUILD_REGISTRY_URL: "http://127.0.0.1:39567",
        PRAETORIUM_BUILD_ALLOW_INSECURE_LOOPBACK_REGISTRY: "true",
      }),
    ).toThrow();
  });

  it("allows explicit anonymous publishing only to the exact TLS loopback host", () => {
    expect(
      readBuildWorkerConfig({
        ...environment,
        PRAETORIUM_BUILD_REGISTRY_URL: "https://127.0.0.1:35009",
        PRAETORIUM_BUILD_ALLOW_ANONYMOUS_LOOPBACK_PUBLISH: "1",
      }),
    ).toMatchObject({
      registryUrl: "https://127.0.0.1:35009",
      registryAllowInsecureLoopback: false,
      registryAllowAnonymousLoopbackPublish: true,
      buildKit: { allowInsecureLoopbackRegistry: true },
    });
    expect(() => readBuildWorkerConfig({
      ...environment,
      PRAETORIUM_BUILD_REGISTRY_URL: "https://127.0.0.1:35009",
      PRAETORIUM_BUILD_ALLOW_ANONYMOUS_LOOPBACK_PUBLISH: "true",
    })).toThrow();
    expect(() => readBuildWorkerConfig({
      ...environment,
      PRAETORIUM_BUILD_REGISTRY_URL: "https://ghcr.io",
      PRAETORIUM_BUILD_ALLOW_ANONYMOUS_LOOPBACK_PUBLISH: "1",
    })).toThrow();
    expect(() => readBuildWorkerConfig({
      ...environment,
      PRAETORIUM_BUILD_REGISTRY_URL: "https://127.0.0.1.example.test:35009",
      PRAETORIUM_BUILD_ALLOW_ANONYMOUS_LOOPBACK_PUBLISH: "1",
    })).toThrow();
    expect(() => readBuildWorkerConfig({
      ...environment,
      PRAETORIUM_BUILD_REGISTRY_URL: "http://127.0.0.1:35009",
      PRAETORIUM_BUILD_ALLOW_ANONYMOUS_LOOPBACK_PUBLISH: "1",
    })).toThrow();
  });
});
