import { describe, expect, it } from "vitest";
import type { UserId } from "../src/domain.js";
import { consumeHandoffCode, createHandoffCode } from "../src/handoff/lifecycle.js";
import { createInMemoryHandoffCodeStore } from "../src/testing/in-memory-handoff-store.js";
import { base64UrlDecode } from "../src/random.js";

const NOW = "2026-10-17T00:00:00.000Z";
const PEPPER = new Uint8Array(32).fill(9);
const HOST = "sample.example.test";
const ORIGIN = `https://${HOST}`;
const USER = "github:4242" as UserId;

function input(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    gatewaySessionDigest: "session-digest",
    repositoryId: 1001,
    instanceId: "ins_01",
    runtimeEpoch: 4,
    hostname: HOST,
    origin: ORIGIN,
    audience: "instance-access" as const,
    returnPath: "/drafts",
    requestedPermissions: ["read", "write"] as const,
    now: NOW,
    ttlSeconds: 60,
    pepper: PEPPER,
    ...overrides,
  };
}

function presented(overrides: Record<string, unknown> = {}) {
  return {
    presentedHostname: HOST,
    presentedRepositoryId: 1001,
    presentedInstanceId: "ins_01",
    presentedRuntimeEpoch: 4,
    presentedOrigin: ORIGIN,
    presentedAudience: "instance-access" as const,
    now: NOW,
    ...overrides,
  };
}

describe("one-use handoff codes", () => {
  it("stores only the digest and carries at least 128 bits of entropy", async () => {
    const store = createInMemoryHandoffCodeStore();
    const created = await createHandoffCode(store, input());
    expect(base64UrlDecode(created.rawCode).length * 8).toBeGreaterThanOrEqual(128);
    expect(created.digest).not.toContain(created.rawCode);
    expect(created.record).toMatchObject({
      repositoryId: 1001,
      instanceId: "ins_01",
      runtimeEpoch: 4,
    });
  });

  it("checks repository, origin and runtime epoch after atomic consumption", async () => {
    for (const mismatch of [
      { presentedRepositoryId: 1002, code: "REPOSITORY_MISMATCH" },
      { presentedOrigin: "https://other.example.test", code: "ORIGIN_MISMATCH" },
      { presentedRuntimeEpoch: 5, code: "RUNTIME_EPOCH_MISMATCH" },
      { presentedHostname: "attacker.example.test", code: "HOSTNAME_MISMATCH" },
    ]) {
      const store = createInMemoryHandoffCodeStore();
      const created = await createHandoffCode(store, input());
      const result = await consumeHandoffCode(store, {
        rawCode: created.rawCode,
        pepper: PEPPER,
        ...presented(mismatch),
      });
      expect(result).toMatchObject({ ok: false, error: { code: mismatch.code } });
      expect(
        await consumeHandoffCode(store, {
          rawCode: created.rawCode,
          pepper: PEPPER,
          ...presented(),
        }),
      ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    }
  });

  it("consumes expired codes and never allows replay, including after a failed binding check", async () => {
    const store = createInMemoryHandoffCodeStore();
    const created = await createHandoffCode(store, input());
    const expired = await consumeHandoffCode(store, {
      rawCode: created.rawCode,
      pepper: PEPPER,
      ...presented({ now: "2026-10-17T00:01:00.000Z" }),
    });
    expect(expired).toMatchObject({ ok: false, error: { code: "EXPIRED" } });
    expect(
      await consumeHandoffCode(store, {
        rawCode: created.rawCode,
        pepper: PEPPER,
        ...presented(),
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("rejects empty read authority and lifetimes longer than the 60-second contract", async () => {
    const store = createInMemoryHandoffCodeStore();
    await expect(
      createHandoffCode(store, input({ requestedPermissions: ["write"], ttlSeconds: 60 })),
    ).rejects.toThrow();
    await expect(createHandoffCode(store, input({ ttlSeconds: 61 }))).rejects.toThrow();
  });
});
