import { describe, expect, it, vi } from "vitest";
import type { ArtifactRegistryProvider } from "@praetorium/application/artifacts";
import { RegistryError } from "@praetorium/ghcr/registry";
import { withAdmissionRegistryDiagnostics } from "./build-composition.js";

describe("admission registry diagnostics", () => {
  it("rethrows the identical image RegistryError and logs only its reason and exact-message code", async () => {
    const error = new RegistryError(
      "invalid_content",
      "registry manifest bytes do not match the requested digest",
    );
    const provider: ArtifactRegistryProvider = {
      verifyImage: vi.fn(async () => {
        throw error;
      }),
      readBlob: vi.fn(),
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        withAdmissionRegistryDiagnostics(provider).verifyImage(
          "approved/image",
          `sha256:${"a".repeat(64)}`,
          { os: "linux", architecture: "amd64" },
        ),
      ).rejects.toBe(error);
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          event: "build_registry_failure",
          phase: "image",
          reason: "invalid_content",
          digest: `sha256:${"a".repeat(64)}`,
          diagnosticCode: "manifest_digest_mismatch",
        }),
      );
      expect(log.mock.calls.flat().join(" ")).not.toContain(error.message);
    } finally {
      log.mockRestore();
    }
  });

  it("rethrows the identical composition RegistryError without logging its URL or credential-like text", async () => {
    const error = new RegistryError(
      "unauthorized",
      "https://user:password@registry.invalid/v2/repo/blobs?token=secret-value",
    );
    const provider: ArtifactRegistryProvider = {
      verifyImage: vi.fn(),
      readBlob: vi.fn(async () => {
        throw error;
      }),
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        withAdmissionRegistryDiagnostics(provider).readBlob(
          "approved/compositions",
          `sha256:${"b".repeat(64)}`,
          1024,
        ),
      ).rejects.toBe(error);
      expect(log).toHaveBeenCalledOnce();
      const serializedLog = log.mock.calls.flat().join(" ");
      expect(serializedLog).toBe(
        JSON.stringify({
          event: "build_registry_failure",
          phase: "composition",
          reason: "unauthorized",
          digest: `sha256:${"b".repeat(64)}`,
        }),
      );
      expect(serializedLog).not.toContain("registry.invalid");
      expect(serializedLog).not.toContain("password");
      expect(serializedLog).not.toContain("secret-value");
    } finally {
      log.mockRestore();
    }
  });

  it("does not log or wrap non-RegistryError failures", async () => {
    const error = new Error("fetch failed");
    const provider: ArtifactRegistryProvider = {
      verifyImage: vi.fn(),
      readBlob: vi.fn(async () => {
        throw error;
      }),
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        withAdmissionRegistryDiagnostics(provider).readBlob(
          "approved/compositions",
          `sha256:${"c".repeat(64)}`,
          1024,
        ),
      ).rejects.toBe(error);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
