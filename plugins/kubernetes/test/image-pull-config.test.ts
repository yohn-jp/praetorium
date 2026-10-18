import { describe, expect, it } from "vitest";
import { validateApplicationImagePullConfig } from "../src/kubernetes/image-pull-config.js";

describe("application image pull configuration", () => {
  it("accepts a self-contained GHCR Docker config", () => {
    expect(() =>
      validateApplicationImagePullConfig(
        JSON.stringify({ auths: { "ghcr.io": { auth: "dXNlcjp0b2tlbg==" } } }),
      ),
    ).not.toThrow();
  });

  it.each([
    "not-json",
    JSON.stringify({ auths: { "docker.io": { auth: "private-value" } } }),
    JSON.stringify({ auths: { "ghcr.io": { auth: "private-value" }, "docker.io": {} } }),
    JSON.stringify({ auths: { "ghcr.io": {} }, credsStore: "secret-helper" }),
    JSON.stringify({ auths: { "ghcr.io": { username: "user" } } }),
  ])("rejects malformed or out-of-scope Docker config without echoing it", (value) => {
    let error: unknown;
    try {
      validateApplicationImagePullConfig(value);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe("application image pull configuration is invalid");
    expect((error as Error).message).not.toContain("private-value");
  });
});
