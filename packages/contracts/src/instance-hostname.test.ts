import { expect, it } from "vitest";
import { instanceHostname, instanceIdFromHostname } from "./instance-hostname.js";
it("preserves stable source hostname derivation and rejects guessed malformed hosts", () => {
  const id = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const host = instanceHostname(id, "instances.test");
  expect(host).toBe("ins-01arz3ndektsv4rrffq69g5fav.instances.test");
  expect(instanceIdFromHostname(host, "instances.test")).toBe(id);
  for (const invalid of [
    host + ".evil",
    host.replace("ins-", "i-"),
    host.toUpperCase(),
    "user@" + host,
  ])
    expect(() => instanceIdFromHostname(invalid, "instances.test")).toThrow();
});
