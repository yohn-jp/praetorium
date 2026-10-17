import { describe, expect, it, vi } from "vitest";
import {
  RuntimeGitCredentialRegistrationSchema,
  type RuntimeGitCredentialRecord,
} from "@praetorium/contracts";
import { createTokenVault, importTokenEncryptionKey } from "@praetorium/auth";
import type { RuntimeIdentity } from "@praetorium/github";
import type { GitHubInstallationTokenRevoker, InstallationToken } from "@praetorium/github";
import { createRuntimeCredentialRegistry } from "../src/adapters/runtime-credential-registry.js";

type ControlPlaneBinding = Parameters<typeof createRuntimeCredentialRegistry>[0]["controlPlane"];

const AUTH = "trusted-control-plane-gateway-secret-000000000000000000000000";
const NOW = new Date("2026-10-17T00:00:00.000Z");
const IDENTITY: RuntimeIdentity = {
  runtimeId: "rt_01",
  instanceId: "ins_01",
  repositoryId: 1001,
  installationId: 71,
  runtimeEpoch: 4,
  leaseId: "lease_01",
};
const CREDENTIAL: InstallationToken = {
  token: "opaque-installation-token-secret",
  expiresAt: "2026-10-17T01:00:00.000Z",
  installationId: 71,
  repositoryId: 1001,
  permission: "read",
};

async function createVault() {
  return createTokenVault(
    [{ id: "registry-test-key", key: await importTokenEncryptionKey(new Uint8Array(32).fill(7)) }],
    "registry-test-key",
  );
}

function binding(
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): ControlPlaneBinding {
  return { fetch } as unknown as ControlPlaneBinding;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function parseRequest(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new TypeError("expected JSON request body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

async function makeRegistry(
  controlPlane: ControlPlaneBinding,
  revoker: GitHubInstallationTokenRevoker = { revoke: async () => undefined },
) {
  return createRuntimeCredentialRegistry({
    controlPlane,
    controlPlaneGatewayAuth: AUTH,
    tokenVault: await createVault(),
    revoker,
    now: () => new Date(NOW),
    timeoutMs: 100,
  });
}

describe("runtime Git credential registry", () => {
  it("registers only ciphertext and does not revoke an active token", async () => {
    let registration: unknown;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://control-plane.internal/internal/runtime-credentials");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("X-Control-Plane-Gateway-Auth")).toBe(AUTH);
      registration = parseRequest(init);
      return json({ status: "active" });
    });
    const revoke = vi.fn(async () => undefined);
    const registry = await makeRegistry(binding(fetch), { revoke });

    await expect(registry.recordIssued(IDENTITY, CREDENTIAL)).resolves.toBe(true);
    const posted = RuntimeGitCredentialRegistrationSchema.parse(registration);
    expect(JSON.stringify(posted)).not.toContain(CREDENTIAL.token);
    expect(posted.encryptedSecret.ciphertext).not.toContain(CREDENTIAL.token);
    expect(posted.tokenId).toMatch(/^[a-f0-9]{64}$/u);
    expect(posted).toMatchObject({
      repositoryId: IDENTITY.repositoryId,
      installationId: IDENTITY.installationId,
      instanceId: IDENTITY.instanceId,
      runtimeId: IDENTITY.runtimeId,
      runtimeEpoch: IDENTITY.runtimeEpoch,
      leaseId: IDENTITY.leaseId,
      permission: CREDENTIAL.permission,
    });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("immediately revokes a pending registration and requires a positive durable ack", async () => {
    const paths: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      paths.push(url);
      if (url.endsWith("/internal/runtime-credentials")) return json({ status: "revocation_pending" });
      if (url.endsWith("/revoked")) return json({ revoked: true });
      throw new Error("unexpected endpoint");
    });
    const revoke = vi.fn(async (credential: InstallationToken) => {
      expect(credential).toEqual(CREDENTIAL);
    });
    const registry = await makeRegistry(binding(fetch), { revoke });

    await expect(registry.recordIssued(IDENTITY, CREDENTIAL)).resolves.toBe(false);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(paths).toHaveLength(2);
    expect(paths[1]).toMatch(/\/internal\/runtime-credentials\/[a-f0-9]{64}\/revoked$/u);
  });

  it("does not revoke a duplicate token already marked revoked", async () => {
    const revoke = vi.fn(async () => undefined);
    const registry = await makeRegistry(
      binding(async () => json({ status: "revoked" })),
      { revoke },
    );

    await expect(registry.recordIssued(IDENTITY, CREDENTIAL)).resolves.toBe(false);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("revokes on registration failure and never treats an HTTP error as durable registration", async () => {
    const fetch = vi.fn(async () => json({ error: "unavailable" }, 503));
    const revoke = vi.fn(async () => undefined);
    const registry = await makeRegistry(binding(fetch), { revoke });

    await expect(registry.recordIssued(IDENTITY, CREDENTIAL)).rejects.toThrow(
      "Control Plane credential request failed with status 503",
    );
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(CREDENTIAL);
    expect(fetch).toHaveBeenCalledTimes(2); // registration plus best-effort acknowledgement
  });

  it("decrypts and verifies the exact token metadata before revoking and acknowledging it", async () => {
    let record: RuntimeGitCredentialRecord | undefined;
    let pendingReads = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/internal/runtime-credentials")) {
        const posted = RuntimeGitCredentialRegistrationSchema.parse(parseRequest(init));
        record = { ...posted, status: "active", createdAt: 1, updatedAt: 1 };
        return json({ status: "active" });
      }
      if (url.endsWith("/pending")) {
        pendingReads += 1;
        if (pendingReads === 1 && record) {
          record = { ...record, status: "revocation_pending" };
          return json({ credentials: [record], remaining: 0 });
        }
        return json({ credentials: [], remaining: 0 });
      }
      if (url.endsWith("/revoked")) {
        expect(record?.status).toBe("revocation_pending");
        record = { ...record!, status: "revoked" };
        return json({ revoked: true });
      }
      throw new Error("unexpected endpoint");
    });
    const revoke = vi.fn(async (credential: InstallationToken) => {
      expect(credential).toEqual(CREDENTIAL);
    });
    const registry = await makeRegistry(binding(fetch), { revoke });
    await expect(registry.recordIssued(IDENTITY, CREDENTIAL)).resolves.toBe(true);

    await expect(
      registry.retire({ repositoryId: IDENTITY.repositoryId, runtimeEpoch: IDENTITY.runtimeEpoch }),
    ).resolves.toEqual({ complete: true });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(pendingReads).toBe(2);
  });

  it("skips a duplicate record already marked revoked", async () => {
    let record: RuntimeGitCredentialRecord | undefined;
    let pendingReads = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/internal/runtime-credentials")) {
        const posted = RuntimeGitCredentialRegistrationSchema.parse(parseRequest(init));
        record = { ...posted, status: "revoked", createdAt: 1, updatedAt: 1 };
        return json({ status: "active" });
      }
      if (url.endsWith("/pending")) {
        pendingReads += 1;
        return pendingReads === 1
          ? json({ credentials: [record], remaining: 0 })
          : json({ credentials: [], remaining: 0 });
      }
      throw new Error("unexpected endpoint");
    });
    const revoke = vi.fn(async () => undefined);
    const registry = await makeRegistry(binding(fetch), { revoke });
    await registry.recordIssued(IDENTITY, CREDENTIAL);

    await expect(
      registry.retire({ repositoryId: IDENTITY.repositoryId, runtimeEpoch: IDENTITY.runtimeEpoch }),
    ).resolves.toEqual({ complete: true });
    expect(revoke).not.toHaveBeenCalled();
    expect(pendingReads).toBe(2);
  });

  it("keeps retirement incomplete and does not acknowledge a failed GitHub revoke", async () => {
    let record: RuntimeGitCredentialRecord | undefined;
    let acknowledgements = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/internal/runtime-credentials")) {
        const posted = RuntimeGitCredentialRegistrationSchema.parse(parseRequest(init));
        record = { ...posted, status: "revocation_pending", createdAt: 1, updatedAt: 1 };
        return json({ status: "active" });
      }
      if (url.endsWith("/pending")) return json({ credentials: [record], remaining: 0 });
      if (url.endsWith("/revoked")) {
        acknowledgements += 1;
        return json({ revoked: true });
      }
      throw new Error("unexpected endpoint");
    });
    const revoke = vi.fn(async () => {
      throw new Error("GitHub returned 401");
    });
    const registry = await makeRegistry(binding(fetch), { revoke });
    await registry.recordIssued(IDENTITY, CREDENTIAL);

    await expect(
      registry.retire({ repositoryId: IDENTITY.repositoryId, runtimeEpoch: IDENTITY.runtimeEpoch }),
    ).resolves.toEqual({ complete: false });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(acknowledgements).toBe(0);
  });

  it("limits retirement revocation work to four concurrent GitHub requests", async () => {
    const records = new Map<string, RuntimeGitCredentialRecord>();
    let pendingReads = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/internal/runtime-credentials")) {
        const posted = RuntimeGitCredentialRegistrationSchema.parse(parseRequest(init));
        records.set(posted.tokenId, {
          ...posted,
          status: "revocation_pending",
          createdAt: 1,
          updatedAt: 1,
        });
        return json({ status: "active" });
      }
      if (url.endsWith("/pending")) {
        pendingReads += 1;
        return pendingReads === 1
          ? json({ credentials: [...records.values()], remaining: 0 })
          : json({ credentials: [], remaining: 0 });
      }
      if (url.endsWith("/revoked")) {
        const tokenId = url.split("/").at(-2)!;
        records.set(tokenId, { ...records.get(tokenId)!, status: "revoked" });
        return json({ revoked: true });
      }
      throw new Error("unexpected endpoint");
    });

    let active = 0;
    let maxActive = 0;
    let started = 0;
    let release!: () => void;
    let signalFourStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      signalFourStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoke = vi.fn(async () => {
      active += 1;
      started += 1;
      maxActive = Math.max(maxActive, active);
      if (started === 4) signalFourStarted();
      await gate;
      active -= 1;
    });
    const registry = await makeRegistry(binding(fetch), { revoke });
    for (let index = 0; index < 6; index += 1) {
      await registry.recordIssued(IDENTITY, {
        ...CREDENTIAL,
        token: `opaque-installation-token-${index}`,
      });
    }

    const retirement = registry.retire({
      repositoryId: IDENTITY.repositoryId,
      runtimeEpoch: IDENTITY.runtimeEpoch,
    });
    await allStarted;
    expect(started).toBe(4);
    release();
    await expect(retirement).resolves.toEqual({ complete: true });
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(revoke).toHaveBeenCalledTimes(6);
  });

  it("fails closed when encrypted metadata is changed or the GitHub revoke is not acknowledged", async () => {
    let record: RuntimeGitCredentialRecord | undefined;
    let ack = false;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/internal/runtime-credentials")) {
        const posted = RuntimeGitCredentialRegistrationSchema.parse(parseRequest(init));
        record = { ...posted, status: "revocation_pending", createdAt: 1, updatedAt: 1 };
        return json({ status: "active" });
      }
      if (url.endsWith("/pending")) {
        return json({ credentials: record ? [record] : [], remaining: 0 });
      }
      if (url.endsWith("/revoked")) {
        if (!ack) return json({ revoked: false });
        return json({ revoked: true });
      }
      throw new Error("unexpected endpoint");
    });
    const revoke = vi.fn(async () => undefined);
    const registry = await makeRegistry(binding(fetch), { revoke });
    await registry.recordIssued(IDENTITY, CREDENTIAL);

    record = { ...record!, permission: "write" };
    await expect(
      registry.retire({ repositoryId: IDENTITY.repositoryId, runtimeEpoch: IDENTITY.runtimeEpoch }),
    ).resolves.toEqual({ complete: false });
    expect(revoke).not.toHaveBeenCalled();

    record = { ...record!, permission: "read" };
    await expect(
      registry.retire({ repositoryId: IDENTITY.repositoryId, runtimeEpoch: IDENTITY.runtimeEpoch }),
    ).resolves.toEqual({ complete: false });
    expect(revoke).toHaveBeenCalledTimes(1);
    ack = true;
  });

  it("times out a stalled Control Plane fetch and revokes the unregistered token", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    const revoke = vi.fn(async () => undefined);
    const registry = createRuntimeCredentialRegistry({
      controlPlane: binding(fetch),
      controlPlaneGatewayAuth: AUTH,
      tokenVault: await createVault(),
      revoker: { revoke },
      now: () => new Date(NOW),
      timeoutMs: 15,
    });

    await expect(registry.recordIssued(IDENTITY, CREDENTIAL)).rejects.toThrow(
      "Control Plane request timed out",
    );
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("times out a stalled Control Plane response body even when stream cancellation stalls", async () => {
    let requests = 0;
    const fetch = vi.fn(async () => {
      requests += 1;
      if (requests > 1) return json({ revoked: true });
      return new Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
          cancel: () => new Promise<void>(() => undefined),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    const revoke = vi.fn(async () => undefined);
    const registry = createRuntimeCredentialRegistry({
      controlPlane: binding(fetch),
      controlPlaneGatewayAuth: AUTH,
      tokenVault: await createVault(),
      revoker: { revoke },
      now: () => new Date(NOW),
      timeoutMs: 15,
    });

    await expect(registry.recordIssued(IDENTITY, CREDENTIAL)).rejects.toThrow(
      "Control Plane request timed out",
    );
    expect(requests).toBe(2); // timed out registration plus positive cleanup acknowledgement
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized Control Plane response metadata before parsing it", async () => {
    const fetch = vi.fn(async () =>
      new Response("{}", {
        headers: { "Content-Type": "application/json", "Content-Length": "4097" },
      }),
    );
    const revoke = vi.fn(async () => undefined);
    const registry = await makeRegistry(binding(fetch), { revoke });

    await expect(registry.recordIssued(IDENTITY, CREDENTIAL)).rejects.toThrow(
      "Control Plane response size is invalid",
    );
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
