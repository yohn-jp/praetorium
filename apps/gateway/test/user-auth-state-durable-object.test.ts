import { describe, expect, it } from "vitest";
import { UserAuthStateDurableObject } from "../src/adapters/durable-objects/user-auth-state-durable-object.js";
import { createFakeDurableObjectState } from "./testing/fake-durable-object-state.js";

function post(path: string, body: unknown): Request {
  return new Request(`https://user-auth-state${path}`, { method: "POST", body: JSON.stringify(body) });
}

const NOW = "2026-08-01T00:00:00.000Z";

describe("UserAuthStateDurableObject sessions", () => {
  it("creates, touches, and revokes a session", async () => {
    const object = new UserAuthStateDurableObject(createFakeDurableObjectState());
    const record = { userId: "usr_1", createdAt: NOW, expiresAt: "2026-08-02T00:00:00.000Z", lastActivityBucket: NOW, revokedAt: null };

    await object.fetch(post("/sessions/create", { digest: "d1", record }));
    expect(await (await object.fetch(post("/sessions/get", { digest: "d1" }))).json()).toEqual({ record });

    await object.fetch(post("/sessions/touch", { digest: "d1", lastActivityBucket: "later", expiresAt: "2026-08-03T00:00:00.000Z" }));
    const touched = (await (await object.fetch(post("/sessions/get", { digest: "d1" }))).json()) as { record: typeof record };
    expect(touched.record.expiresAt).toBe("2026-08-03T00:00:00.000Z");

    await object.fetch(post("/sessions/revoke", { digest: "d1", revokedAt: NOW }));
    const revoked = (await (await object.fetch(post("/sessions/get", { digest: "d1" }))).json()) as { record: typeof record };
    expect(revoked.record.revokedAt).toBe(NOW);
  });

  it("counts only active sessions and revoke-all clears every one", async () => {
    const object = new UserAuthStateDurableObject(createFakeDurableObjectState());
    const active = { userId: "usr_1", createdAt: NOW, expiresAt: "2099-01-01T00:00:00.000Z", lastActivityBucket: NOW, revokedAt: null };
    const expired = { ...active, expiresAt: "2020-01-01T00:00:00.000Z" };

    await object.fetch(post("/sessions/create", { digest: "active-1", record: active }));
    await object.fetch(post("/sessions/create", { digest: "active-2", record: active }));
    await object.fetch(post("/sessions/create", { digest: "expired-1", record: expired }));

    const countResponse = await object.fetch(post("/sessions/count-active", { now: NOW }));
    expect(await countResponse.json()).toEqual({ count: 2 });

    await object.fetch(post("/sessions/revoke-all", { revokedAt: NOW }));
    const afterRevoke = await object.fetch(post("/sessions/count-active", { now: NOW }));
    expect(await afterRevoke.json()).toEqual({ count: 0 });
  });

  it("touch/revoke on an unknown digest is a safe no-op", async () => {
    const object = new UserAuthStateDurableObject(createFakeDurableObjectState());
    const response = await object.fetch(post("/sessions/touch", { digest: "missing", lastActivityBucket: NOW, expiresAt: NOW }));
    expect(response.status).toBe(204);
  });
});

describe("UserAuthStateDurableObject credentials", () => {
  it("creates, lists, touches last-used, and revokes a credential", async () => {
    const object = new UserAuthStateDurableObject(createFakeDurableObjectState());
    const record = { name: "cli", scopes: ["mcp:connect"], createdAt: NOW, expiresAt: "2099-01-01T00:00:00.000Z", lastUsedAt: null, revokedAt: null };

    await object.fetch(post("/credentials/create", { digest: "c1", record }));
    expect(await (await object.fetch(post("/credentials/list", {}))).json()).toEqual({
      items: [{ digest: "c1", record }],
    });

    await object.fetch(post("/credentials/touch-last-used", { digest: "c1", lastUsedAt: NOW }));
    const touched = (await (await object.fetch(post("/credentials/get", { digest: "c1" }))).json()) as { record: typeof record };
    expect(touched.record.lastUsedAt).toBe(NOW);

    await object.fetch(post("/credentials/revoke-all", { revokedAt: NOW }));
    const revoked = (await (await object.fetch(post("/credentials/get", { digest: "c1" }))).json()) as { record: typeof record };
    expect(revoked.record.revokedAt).toBe(NOW);
  });
});

describe("UserAuthStateDurableObject transport", () => {
  it("rejects non-POST methods and unknown paths", async () => {
    const object = new UserAuthStateDurableObject(createFakeDurableObjectState());
    expect((await object.fetch(new Request("https://user-auth-state/sessions/get"))).status).toBe(405);
    expect((await object.fetch(post("/nope", {}))).status).toBe(404);
  });
});
