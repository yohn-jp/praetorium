import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { InstanceService, RepositoryRegistryService } from "@praetorium/application/instances";
import { createControlPlaneApp } from "./app.js";

describe("dedicated Admin service-credential scope", () => {
  const gateway = "g".repeat(48);
  const admin = "a".repeat(48);
  function app() {
    return createControlPlaneApp({
      gatewaySecret: gateway, adminSecret: admin,
      registry: {} as RepositoryRegistryService,
      instances: {} as InstanceService,
    });
  }
  const headers = { "X-Control-Plane-Admin-Auth": admin };

  it("admits only the single read-only operation evidence route", async () => {
    const cp = app();
    const allowed = await cp.request("/v1/operations/op_check/evidence", { headers });
    expect(allowed.status).toBe(404); // Auth passed; no operation service is mounted.
    const denied = await cp.request("/v1/operations/op_check/retry", {
      method: "POST", headers,
    });
    expect(denied.status).toBe(401);
    const other = await cp.request("/v1/instances/instance-check/audit", { headers });
    expect(other.status).toBe(401);
  });

  it("keeps Gateway and Admin credentials distinct and requires authentication", async () => {
    const cp = app();
    expect((await cp.request("/v1/operations/op_check/evidence")).status).toBe(401);
    expect((await cp.request("/v1/operations/op_check/evidence", {
      headers: { "X-Control-Plane-Admin-Auth": gateway },
    })).status).toBe(401);
    expect((await cp.request("/v1/operations/op_check/evidence", {
      headers: { "X-Control-Plane-Gateway-Auth": gateway },
    })).status).toBe(404);
    expect((await cp.request("/v1/operator/source-builds", { headers })).status).toBe(404);
  });

  it("admits canonical system-canary UUID evidence without admitting mutation or unsafe IDs", async () => {
    const cp = app();
    const id = "operation_7e53e854-11d8-4722-b8d5-278a796a47d4";
    const path = `/v1/operations/${id}/evidence`;
    expect((await cp.request(path, { headers })).status).toBe(404);
    expect((await cp.request(path)).status).toBe(401);
    expect((await cp.request(path, {
      headers: { "X-Control-Plane-Admin-Auth": gateway },
    })).status).toBe(401);
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await cp.request(path, { method, headers })).status).toBe(401);
    }
    expect((await cp.request(`/v1/operations/${id}/retry`, {
      method: "POST", headers,
    })).status).toBe(401);
    for (const invalidId of [
      "operation_invalid", `${id}-extra`, "op_" + "a".repeat(125),
      `${id}%2Fretry`,
    ]) {
      expect((await cp.request(`/v1/operations/${invalidId}/evidence`, { headers })).status).toBe(401);
    }
  });

  it("keeps runtime credential reuse behind Gateway service authentication", async () => {
    const credentialRoutes = new Hono();
    credentialRoutes.post("/internal/runtime-credentials/reuse", (context) =>
      context.json({ credential: null }),
    );
    const cp = createControlPlaneApp({
      gatewaySecret: gateway,
      adminSecret: admin,
      registry: {} as RepositoryRegistryService,
      instances: {} as InstanceService,
      runtimeCredentials: credentialRoutes,
    });
    const path = "/internal/runtime-credentials/reuse";

    expect((await cp.request(path, { method: "POST" })).status).toBe(401);
    expect((await cp.request(path, { method: "POST", headers })).status).toBe(401);
    expect((await cp.request(path, {
      method: "POST",
      headers: { "X-Control-Plane-Gateway-Auth": gateway },
    })).status).toBe(200);
  });
});
