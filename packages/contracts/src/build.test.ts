import { describe, expect, it } from "vitest";
import { buildKey, BuildInputSchema } from "./build.js";
import { validateGrantBinding } from "./access.js";
const d = `sha256:${"a".repeat(64)}`;
const input = {
  contractVersion: "scriptorium-build/v1",
  producerRevision: "a".repeat(40),
  runtimeBaseDigest: d,
  buildKitDigest: d,
  recipeDigest: d,
  sourceDigest: d,
  lockDigest: d,
  requestedModules: ["b", "a"],
  resolvedModules: [
    { id: "b", version: "1", artifactDigest: d },
    { id: "a", version: "1", artifactDigest: d },
  ],
  platform: "linux/amd64",
  options: {},
};
describe("immutable composition identity", () => {
  it("normalizes module order and separates output affecting inputs", async () => {
    expect(await buildKey(input)).toBe(
      await buildKey({
        ...input,
        requestedModules: ["a", "b"],
        resolvedModules: [...input.resolvedModules].reverse(),
      }),
    );
    for (const changed of [
      { platform: "linux/arm64" },
      { recipeDigest: `sha256:${"b".repeat(64)}` },
      { buildKitDigest: `sha256:${"b".repeat(64)}` },
    ])
      expect(await buildKey({ ...input, ...changed })).not.toBe(await buildKey(input));
  });
  it("rejects tenant fields and duplicates", async () => {
    expect(BuildInputSchema.safeParse({ ...input, repositoryId: 1 }).success).toBe(false);
    await expect(buildKey({ ...input, requestedModules: ["a", "a"] })).rejects.toThrow();
  });
});
it("rejects wrong host repository epoch and expired grants", () => {
  const expected = {
    issuer: "https://gateway.test",
    audience: "https://i.test",
    instanceId: "i",
    repositoryId: 1,
    runtimeEpoch: 2,
    now: 100,
  };
  const grant = {
    iss: expected.issuer,
    sub: "u",
    aud: expected.audience,
    instanceId: "i",
    repositoryId: 1,
    runtimeEpoch: 2,
    permissions: ["read"],
    sessionRevision: 1,
    authorizationRevision: 1,
    iat: 90,
    nbf: 90,
    exp: 200,
    jti: "j",
  };
  expect(validateGrantBinding(grant, expected).sub).toBe("u");
  for (const changed of [
    { aud: "https://other.test" },
    { repositoryId: 2 },
    { runtimeEpoch: 1 },
    { exp: 99 },
  ])
    expect(() => validateGrantBinding({ ...grant, ...changed }, expected)).toThrow();
});
