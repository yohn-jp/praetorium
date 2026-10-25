import { describe, expect, it } from "vitest";
import { authorizeConfiguredReleaseOperator, ReleaseCanaryBindingSchema } from "./release-composition.js";

const config = {
  operatorToken: "operator-separate-machine-credential-" + "a".repeat(32),
  gatewayServiceSecret: "existing-private-gateway-secret-" + "b".repeat(32),
  operatorActorId: "213253858",
};

describe("Operator-selected Canary ownership", () => {
  const binding = {
    owner: "yohn-jp",
    repositoryId: 1289100245,
    instanceId: "ins_01M56ESQH0YF3R4NX0X2AB8HG5",
    bindingEpoch: 1,
    authorizationRevision: 0,
    requestedModules: ["mcp"],
    resourceProfileId: "balanced",
  };
  it.each([
    { disposable: true, production: false },
    { disposable: false, production: true },
  ])("preserves the explicitly configured ownership $disposable/$production", (ownership) => {
    expect(ReleaseCanaryBindingSchema.parse({ ...binding, ...ownership })).toEqual({
      ...binding,
      ...ownership,
    });
  });
  it.each([
    { disposable: true, production: true },
    { disposable: false, production: false },
    { disposable: "false", production: true },
  ])("rejects contradictory or untyped ownership", (ownership) => {
    expect(ReleaseCanaryBindingSchema.safeParse({ ...binding, ...ownership }).success).toBe(false);
  });
});

describe("Operator admission authority", () => {
  it("preserves the independent machine operator token", async () => {
    expect(await authorizeConfiguredReleaseOperator(
      new Headers({ Authorization: "Bearer " + config.operatorToken }), config,
    )).toEqual({ actorId: config.operatorActorId });
  });

  it("authorizes only a signed-in administrator forwarded through the existing Gateway binding", async () => {
    const allowed = new Headers({
      "X-Control-Plane-Gateway-Auth": config.gatewayServiceSecret,
      "X-Praetorium-Admin-Actor": "213253858",
    });
    expect(await authorizeConfiguredReleaseOperator(allowed, config)).toEqual({ actorId: "213253858" });
    for (const changed of [
      new Headers({ "X-Control-Plane-Gateway-Auth": config.gatewayServiceSecret,
        "X-Praetorium-Admin-Actor": "999" }),
      new Headers({ "X-Praetorium-Admin-Actor": "213253858" }),
      new Headers({ "X-Control-Plane-Gateway-Auth": "forged",
        "X-Praetorium-Admin-Actor": "213253858" }),
      new Headers({ Authorization: "Bearer untrusted-token",
        "X-Praetorium-Admin-Actor": "213253858" }),
    ]) {
      expect(await authorizeConfiguredReleaseOperator(changed, config)).toBeNull();
    }
    expect(await authorizeConfiguredReleaseOperator(allowed, {
      ...config, gatewayServiceSecret: undefined,
    })).toBeNull();
  });
});
