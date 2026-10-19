import { describe, expect, it } from "vitest";
import {
  applicationFromHostname,
  applicationHostname,
  bindingIdFromPhysicalInstanceId,
  physicalInstanceId,
} from "./application-origin.js";
import { instanceHostname, instanceIdFromHostname } from "./instance-hostname.js";

const binding = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
describe("registered application and physical runtime identities", () => {
  it("keeps the public origin stable across replacement and rollback", () => {
    const first = physicalInstanceId(binding, 4, null);
    const replacement = physicalInstanceId(binding, 5, null);
    const rollback = physicalInstanceId(binding, 6, null);
    expect(new Set([first, replacement, rollback]).size).toBe(3);
    expect(bindingIdFromPhysicalInstanceId(replacement)).toBe(binding);
    expect(applicationHostname("scriptorium", 482901)).toBe("482901.scriptorium.yohn.jp");
    const host = instanceHostname(replacement, "instances.praetorium.yohn.jp");
    expect(host).toBe("01arz3ndektsv4rrffq69g5fav-5.instances.praetorium.yohn.jp");
    expect(instanceIdFromHostname(host, "instances.praetorium.yohn.jp")).toBe(replacement);
    expect(host).not.toContain("ins-");
  });

  it("retains source runtime identity only at its recorded migration epoch", () => {
    expect(physicalInstanceId(binding, 4, 4)).toBe(binding);
    expect(physicalInstanceId(binding, 5, 4)).not.toBe(binding);
    expect(physicalInstanceId(binding, 6, 4)).not.toBe(physicalInstanceId(binding, 5, 4));
  });

  it("rejects host aliases, unregistered apps and invalid repository IDs", () => {
    expect(applicationFromHostname("482901.scriptorium.yohn.jp")).toEqual({
      appIdentity: "scriptorium",
      repositoryId: 482901,
    });
    for (const host of [
      "0482901.scriptorium.yohn.jp",
      "0.scriptorium.yohn.jp",
      "9007199254740992.scriptorium.yohn.jp",
      "482901.ide.yohn.jp",
      "482901.scriptorium.yohn.jp.evil",
      "482901.scriptorium.yohn.jp.",
      "ins-01arz3ndektsv4rrffq69g5fav.instances.praetorium.yohn.jp",
    ]) {
      expect(() => applicationFromHostname(host)).toThrow();
    }
    expect(() => applicationHostname("ide", 482901)).toThrow();
    expect(() => physicalInstanceId(binding, 0, null)).toThrow();
    expect(() => physicalInstanceId(binding, Number.MAX_SAFE_INTEGER + 1, null)).toThrow();
  });
});
