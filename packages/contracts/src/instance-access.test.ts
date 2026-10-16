import { expect, it } from "vitest";
import { RedeemHandoffRequestSchema } from "./instance-access.js";
it("derives exact host binding without client-selected epochs", () => {
  const input = {
    contractVersion: "instance-access/v1",
    audience: "instance-access",
    instanceId: "i",
    hostname: "i.test",
    origin: "https://i.test",
    code: "x".repeat(32),
    returnPath: "/edit",
  };
  expect(RedeemHandoffRequestSchema.safeParse(input).success).toBe(true);
  for (const fields of [
    { origin: "https://other.test" },
    { origin: "https://u:p@i.test" },
    { returnPath: "//other.test" },
    { returnPath: "/\\evil.test" },
    { runtimeEpoch: 2 },
  ])
    expect(RedeemHandoffRequestSchema.safeParse({ ...input, ...fields }).success).toBe(false);
});
