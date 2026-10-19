import { describe, expect, it, vi } from "vitest";
import type { RuntimeAssignment } from "@praetorium/application/lifecycle";
import { CloudflareApplicationDns } from "./application-dns.js";

const name = "482901.scriptorium.yohn.jp";
const binding = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const target = "01arz3ndektsv4rrffq69g5fav-5.instances.praetorium.yohn.jp";
const owned = {
  id: "b".repeat(32),
  type: "CNAME",
  name,
  content: target,
  proxied: false,
  ttl: 60,
  comment: `praetorium:scriptorium:482901:${binding}`,
};
const assignment = {
  instanceId: binding,
  repositoryId: 482901,
  runtimeEpoch: 5,
  deployment: {
    legacyRuntimeEpoch: null,
    hostname: name,
    grantPolicy: { audience: `https://${name}` },
  },
} as RuntimeAssignment;

function harness(initial?: Record<string, unknown>) {
  let record = initial;
  const effects: string[] = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, input?: RequestInit) => {
    effects.push(input!.method!);
    if (input!.method !== "GET") {
      record = { ...JSON.parse(String(input!.body)), id: owned.id };
      return Response.json({ success: true, result: record });
    }
    return Response.json({
      success: true,
      result: record ? [record] : [],
      result_info: { total_count: record ? 1 : 0 },
    });
  });
  const publisher = new CloudflareApplicationDns({
    zoneId: "a".repeat(32),
    token: "s".repeat(48),
    instanceHostnameSuffix: "instances.praetorium.yohn.jp",
    fetch: fetcher,
  });
  const guard = vi.fn(async () => {
    effects.push("fence");
  });
  return { publisher, fetcher, guard, effects };
}

describe("application CNAME publication", () => {
  it("creates a DNS-only per-application record after checking the operation fence", async () => {
    const h = harness();
    await h.publisher.publish(assignment, h.guard);
    expect(h.effects).toEqual(["fence", "GET", "fence", "POST", "fence", "GET"]);
    expect(JSON.parse(String(h.fetcher.mock.calls[1]![1]!.body))).toEqual({
      type: "CNAME",
      name,
      content: target,
      comment: owned.comment,
      proxied: false,
      ttl: 60,
    });
  });
  it("reconciles a replacement and idempotently verifies a lost-response retry", async () => {
    const h = harness({ ...owned, content: "previous.instances.praetorium.yohn.jp" });
    await h.publisher.publish(assignment, h.guard);
    expect(h.effects).toContain("PATCH");
    h.effects.length = 0;
    await h.publisher.publish(assignment, h.guard);
    expect(h.effects).toEqual(["fence", "GET", "fence", "GET"]);
  });
  it("never overwrites a foreign record or mutates after loss of operation authority", async () => {
    for (const record of [
      { ...owned, comment: "other-owner" },
      { ...owned, type: "A" },
    ]) {
      const h = harness(record);
      await expect(h.publisher.publish(assignment, h.guard)).rejects.toThrow("not owned");
      expect(h.effects).toEqual(["fence", "GET"]);
    }
    const h = harness();
    h.guard.mockRejectedValueOnce(new Error("lease lost"));
    await expect(h.publisher.publish(assignment, h.guard)).rejects.toThrow("lease lost");
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("rejects provider failure and an origin not belonging to the assigned repository", async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(Response.json({ success: false }, { status: 503 }));
    await expect(h.publisher.publish(assignment, h.guard)).rejects.toThrow("unavailable");
    await expect(
      h.publisher.publish({ ...assignment, repositoryId: 482902 }, h.guard),
    ).rejects.toThrow("origin mismatch");
  });
});
