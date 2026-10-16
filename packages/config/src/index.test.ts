import { expect, it } from "vitest";
import { HttpsOriginSchema, redactSecrets, requireSecret } from "./index.js";
it("origin rejects credentials and resource paths", () => {
  for (const value of [
    "http://host.test",
    "https://u:p@host.test",
    "https://host.test/path",
    "https://host.test?x=1",
  ])
    expect(HttpsOriginSchema.safeParse(value).success).toBe(false);
  expect(HttpsOriginSchema.safeParse("https://host.test").success).toBe(true);
});
it("secret failure and nested redaction do not print values", () => {
  expect(() => requireSecret("x", "APP_KEY")).toThrow("APP_KEY");
  expect(redactSecrets({ token: "x", nested: [{ privateKey: "k", id: 1 }] })).toEqual({
    token: "[REDACTED]",
    nested: [{ privateKey: "[REDACTED]", id: 1 }],
  });
});
