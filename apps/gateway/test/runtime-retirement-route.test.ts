import { describe, expect, it, vi } from "vitest";
import type { GatewayContext } from "../src/context.js";
import { createGatewayRouter } from "../src/router.js";
import { SESSION_COOKIE_NAME } from "../src/http/session.js";

const secret = "retirement-authority-".padEnd(48, "s");
function setup(retire = vi.fn(async () => ({ complete: true }))) {
  const context = {
    env: { RUNTIME_CREDENTIAL_RETIREMENT_AUTH: secret },
    config: { origin: "https://gateway.test" },
    runtimeCredentialRegistry: { retire },
    requestId: "retirement-route-test",
  } as unknown as GatewayContext;
  return { app: createGatewayRouter(context), retire };
}
function request(
  authorization = `Bearer ${secret}`,
  cookie?: string,
  body: unknown = { repositoryId: 17, runtimeEpoch: 4 },
) {
  return new Request("https://gateway.test/internal/github/retire", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("private Gateway credential retirement route", () => {
  it("requires its separate service authority and rejects browser sessions before side effects", async () => {
    const { app, retire } = setup();
    for (const authorization of [
      "",
      "Bearer gateway-service-secret",
      "Bearer provisioner-service-secret",
    ])
      expect((await app.fetch(request(authorization))).status).toBe(401);
    expect(
      (await app.fetch(request(`Bearer ${secret}`, `${SESSION_COOKIE_NAME}=browser-session`)))
        .status,
    ).toBe(401);
    expect(retire).not.toHaveBeenCalled();
  });
  it("forwards only a validated repository and epoch to the registry", async () => {
    const { app, retire } = setup();
    expect(
      (
        await app.fetch(
          request(undefined, undefined, { repositoryId: 17, runtimeEpoch: 4, token: "untrusted" }),
        )
      ).status,
    ).toBe(400);
    expect(retire).not.toHaveBeenCalled();
    const response = await app.fetch(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ complete: true });
    expect(retire).toHaveBeenCalledWith({ repositoryId: 17, runtimeEpoch: 4 });
  });
  it("keeps pending or failed revocation unavailable without exposing failure details", async () => {
    const retire = vi.fn(async (): Promise<{ complete: boolean }> => ({ complete: false }));
    const { app } = setup(retire);
    expect((await app.fetch(request())).status).toBe(503);
    retire.mockRejectedValueOnce(new Error("opaque-secret-token"));
    const response = await app.fetch(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("opaque-secret-token");
  });
});
