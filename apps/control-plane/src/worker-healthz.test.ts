import { describe, expect, it } from "vitest";
import controlPlane, { type ControlPlaneEnv } from "./worker.js";

describe("Control Plane Worker health probe", () => {
  it("answers GET /healthz without reading environment bindings", async () => {
    const env = new Proxy(
      {},
      {
        get(_target, key) {
          throw new Error(`health probe must not read ${String(key)}`);
        },
      },
    ) as ControlPlaneEnv;

    const response = await controlPlane.fetch(
      new Request("https://control-plane.example/healthz"),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
