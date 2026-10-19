import { expect, it } from "vitest";
import { RedeemHandoffRequestSchema } from "./instance-access.js";
it("derives exact host binding without client-selected epochs", () => {
  const input = {
    contractVersion: "instance-access/v2",
    audience: "instance-access",
    appIdentity: "scriptorium", repositoryId: 482901,
    hostname: "482901.scriptorium.yohn.jp",
    origin: "https://482901.scriptorium.yohn.jp",
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
