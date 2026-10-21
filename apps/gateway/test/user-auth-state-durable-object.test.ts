import { describe, expect, it, vi } from "vitest";
import { UserAuthStateDurableObject } from "../src/adapters/durable-objects/user-auth-state-durable-object.js";
import { createDurableObjectSessionStore } from "../src/adapters/durable-objects/user-auth-state-client.js";
import { createFakeDurableObjectState } from "./testing/fake-durable-object-state.js";
import { createSession, type UserId } from "@praetorium/auth";

function post(path: string, body: unknown): Request {
  return new Request(`https://user-auth-state${path}`, { method: "POST", body: JSON.stringify(body) });
}

const NOW = "2026-08-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

async function seedCredentialRows(state: ReturnType<typeof createFakeDurableObjectState>, count: number): Promise<void> {
  await state.storage.put("session-index:v1:ready", true);
  await state.storage.put("credential-index:v2:ready", true);
  await state.storage.put("credential-generation:v1:current", 0);
  await state.storage.put("credential-generation:v1:revoked-through", 0);
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(4, "0");
    const digest = "digest-" + suffix;
    const id = "credential-" + suffix;
    const record = {
      id, userId: "usr_1", name: "test", permissions: ["read"],
      createdAt: NOW, expiresAt: FUTURE, lastUsedAt: null, revokedAt: null,
    };
    await state.storage.put("credential:" + digest, record);
    await state.storage.put("credential-active:" + digest, { expiresAt: FUTURE, revokedAt: null });
    await state.storage.put("credential-record-epoch:" + digest, 0);
    await state.storage.put("credential-generation-index:0000000000000000:" + digest, { digest });
    await state.storage.put("credential-id:" + encodeURIComponent(id), digest);
    const expiryAt = String(Date.parse(FUTURE)).padStart(16, "0");
    await state.storage.put("auth-expiry:" + expiryAt + ":credential:" + digest, {
      kind: "credential", digest,
    });
  }
}

describe("UserAuthStateDurableObject sessions", () => {
  it("atomically admits only one of two concurrent sessions at limit one", async () => {
    const object = new UserAuthStateDurableObject(createFakeDurableObjectState());
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) => object.fetch(new Request(input, init)),
      }),
    } as unknown as DurableObjectNamespace;
    const digestUser = new Map<string, UserId>();
    const expirations = new Map<string, string | undefined>();
    const store = createDurableObjectSessionStore(namespace, {
      async set(digest, userId, expiresAt) {
        digestUser.set(digest, userId);
        expirations.set(digest, expiresAt);
      },
      async get(digest) { return digestUser.get(digest) ?? null; },
      async delete(digest) { digestUser.delete(digest); expirations.delete(digest); },
    });
    const create = () => createSession(store, {
      userId: "213253858" as UserId,
      authenticationContext: "github-oauth",
      now: NOW,
      ttlSeconds: 3600,
      pepper: new Uint8Array(32).fill(9),
      concurrentSessionLimit: 1,
    });

    const results = await Promise.all([create(), create()]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok &&
      result.error.code === "CONCURRENT_SESSION_LIMIT_EXCEEDED")).toHaveLength(1);
    await expect(store.countActiveForUser("213253858" as UserId, NOW)).resolves.toBe(1);
  });

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

  it("extends the routing index TTL on sliding touches and removes stale routes", async () => {
    const state = createFakeDurableObjectState();
    const object = new UserAuthStateDurableObject(state);
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) => object.fetch(new Request(input, init)),
      }),
    } as unknown as DurableObjectNamespace;
    const routes = new Map<string, UserId>();
    const expiry = new Map<string, string | undefined>();
    const store = createDurableObjectSessionStore(namespace, {
      async set(digest, userId, expiresAt) {
        routes.set(digest, userId);
        expiry.set(digest, expiresAt);
      },
      async get(digest) { return routes.get(digest) ?? null; },
      async delete(digest) { routes.delete(digest); expiry.delete(digest); },
    });
    const record = {
      userId: "213253858" as UserId,
      sessionRevision: 0,
      createdAt: NOW,
      expiresAt: "2026-08-02T00:00:00.000Z",
      lastActivityBucket: NOW,
      authenticationContext: "github-oauth" as const,
      rotatedFromDigest: null,
      revokedAt: null,
    };
    await store.create("sliding", record);
    await store.touch("sliding", "2026-08-01T01:00:00.000Z", "2026-08-03T00:00:00.000Z");
    expect(expiry.get("sliding")).toBe("2026-08-03T00:00:00.000Z");

    await state.storage.delete("session:sliding");
    await expect(store.get("sliding")).resolves.toBeNull();
    expect(routes.has("sliding")).toBe(false);
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

  it("counts from the active index after one-time legacy backfill", async () => {
    const state = createFakeDurableObjectState();
    await state.storage.put("session-index:v1:ready", true);
    await state.storage.put("credential-index:v2:ready", true);
    const expired = {
      userId: "usr_1", createdAt: NOW, expiresAt: "2020-01-01T00:00:00.000Z",
      lastActivityBucket: NOW, revokedAt: null,
    };
    for (let index = 0; index < 1_000; index += 1) {
      await state.storage.put(`session:legacy-${String(index).padStart(4, "0")}`, expired);
    }
    const active = { ...expired, expiresAt: "2099-01-01T00:00:00.000Z" };
    await state.storage.put("session:active", active);
    await state.storage.put("session-active:active", {
      expiresAt: active.expiresAt, revokedAt: null,
    });
    state.testMetrics.listCalls = 0;
    state.testMetrics.rowsReturned = 0;
    state.testMetrics.maxRowsPerList = 0;

    const object = new UserAuthStateDurableObject(state);
    const response = await object.fetch(post("/sessions/count-active", { now: NOW }));
    expect(await response.json()).toEqual({ count: 1 });
    expect(state.testMetrics.listCalls).toBe(1);
    expect(state.testMetrics.rowsReturned).toBe(1);
    expect(state.testMetrics.maxRowsPerList).toBe(1);
  });

  it("backfills legacy auth rows in bounded pages before counting active sessions", async () => {
    const state = createFakeDurableObjectState();
    const expired = {
      userId: "usr_1", createdAt: NOW, expiresAt: "2020-01-01T00:00:00.000Z",
      lastActivityBucket: NOW, revokedAt: null,
    };
    for (let index = 0; index < 1_000; index += 1) {
      await state.storage.put(`session:legacy-${String(index).padStart(4, "0")}`, expired);
    }
    await state.storage.put("session:active", { ...expired, expiresAt: "2099-01-01T00:00:00.000Z" });
    const object = new UserAuthStateDurableObject(state);
    state.testMetrics.listCalls = 0;
    state.testMetrics.rowsReturned = 0;
    state.testMetrics.maxRowsPerList = 0;

    let attempts = 0;
    let response: Response | undefined;
    while (attempts < 20) {
      attempts += 1;
      response = await object.fetch(post("/sessions/count-active", { now: NOW }));
      if (response.status === 200) break;
      expect(response.status).toBe(503);
    }

    expect(attempts).toBe(11);
    expect(await response?.json()).toEqual({ count: 1 });
    expect(state.testMetrics.listCalls).toBe(12);
    expect(state.testMetrics.rowsReturned).toBe(1_002);
    expect(state.testMetrics.maxRowsPerList).toBe(100);
    expect((await state.storage.list({ prefix: "session:" })).size).toBe(1);
  });

  it("garbage-collects expired session records in bounded alarm batches", async () => {
    const state = createFakeDurableObjectState();
    await state.storage.put("session-index:v1:ready", true);
    await state.storage.put("credential-index:v2:ready", true);
    const object = new UserAuthStateDurableObject(state);
    const expired = {
      userId: "usr_1", createdAt: NOW, expiresAt: "2020-01-01T00:00:00.000Z",
      lastActivityBucket: NOW, revokedAt: null,
    };
    for (let index = 0; index < 120; index += 1) {
      await object.fetch(post("/sessions/create", { digest: `old-${index}`, record: expired }));
    }
    state.testMetrics.listCalls = 0;
    state.testMetrics.rowsReturned = 0;
    state.testMetrics.maxRowsPerList = 0;

    await object.alarm();
    expect(state.testMetrics.maxRowsPerList).toBeLessThanOrEqual(100);
    expect(state.testMetrics.listCalls).toBe(2);
    expect(state.testMetrics.rowsReturned).toBe(101);
    expect(state.testMetrics.maxRowsPerList).toBe(100);
    expect((await state.storage.list({ prefix: "session:" })).size).toBe(20);
    state.testMetrics.listCalls = 0;
    state.testMetrics.rowsReturned = 0;
    state.testMetrics.maxRowsPerList = 0;
    await object.alarm();
    expect(state.testMetrics.listCalls).toBe(2);
    expect(state.testMetrics.rowsReturned).toBe(20);
    expect(state.testMetrics.maxRowsPerList).toBe(20);
    expect((await state.storage.list({ prefix: "session:" })).size).toBe(0);
    expect(await state.storage.getAlarm()).toBeNull();
  });

  it("touch/revoke on an unknown digest is a safe no-op", async () => {
    const object = new UserAuthStateDurableObject(createFakeDurableObjectState());
    const response = await object.fetch(post("/sessions/touch", { digest: "missing", lastActivityBucket: NOW, expiresAt: NOW }));
    expect(response.status).toBe(204);
  });

  it("retains a session until future revocation grace closes, then collects it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const state = createFakeDurableObjectState();
    const object = new UserAuthStateDurableObject(state);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const graceEnd = new Date(Date.now() + 120_000).toISOString();
    const record = {
      userId: "usr_1", createdAt: now,
      expiresAt,
      lastActivityBucket: now, revokedAt: null,
    };
    try {
      await object.fetch(post("/sessions/create", { digest: "grace", record }));
      await object.fetch(post("/sessions/revoke", { digest: "grace", revokedAt: graceEnd }));
      const count = await object.fetch(post("/sessions/count-active", { now }));
      expect(await count.json()).toEqual({ count: 1 });

      vi.setSystemTime(Date.parse(expiresAt) + 1);
      await state.storage.deleteAlarm();
      await object.alarm();
      const retained = await (await object.fetch(post("/sessions/get", { digest: "grace" }))).json() as {
        record: { expiresAt: string; revokedAt: string | null };
      };
      expect(retained.record).toMatchObject({ expiresAt, revokedAt: graceEnd });
      expect(await state.storage.getAlarm()).toBe(Date.parse(graceEnd));

      vi.setSystemTime(Date.parse(graceEnd) + 1);
      await state.storage.deleteAlarm();
      await object.alarm();
      expect(await (await object.fetch(post("/sessions/get", { digest: "grace" }))).json())
        .toEqual({ record: null });
      expect(await state.storage.getAlarm()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("UserAuthStateDurableObject credentials", () => {
  it("creates, lists, touches last-used, and revokes a credential", async () => {
    const object = new UserAuthStateDurableObject(createFakeDurableObjectState());
    const record = {
      id: "credential-c1", userId: "usr_1", name: "cli", permissions: ["read"],
      createdAt: NOW, expiresAt: FUTURE, lastUsedAt: null, revokedAt: null,
    };

    await object.fetch(post("/credentials/create", { digest: "c1", record }));
    expect(await (await object.fetch(post("/credentials/list", {}))).json()).toEqual({
      items: [{ digest: "c1", record }],
    });

    await object.fetch(post("/credentials/touch-last-used", { digest: "c1", lastUsedAt: NOW }));
    const touched = (await (await object.fetch(post("/credentials/get", { digest: "c1" }))).json()) as { record: typeof record };
    expect(touched.record.lastUsedAt).toBe(NOW);

    await object.fetch(post("/credentials/revoke-all", { revokedAt: NOW }));
    expect(await (await object.fetch(post("/credentials/get", { digest: "c1" }))).json())
      .toEqual({ record: null });

    const afterRevokeAll = { ...record, id: "credential-c2" };
    expect((await object.fetch(post("/credentials/create", {
      digest: "c2", record: afterRevokeAll,
    }))).status).toBe(204);
    expect(await (await object.fetch(post("/credentials/get", { digest: "c2" }))).json())
      .toEqual({ record: afterRevokeAll });
  });

  it("backfills legacy credential ID routes even when the old index-ready marker exists", async () => {
    const state = createFakeDurableObjectState();
    await state.storage.put("credential-index:v1:ready", true);
    await state.storage.put("session-index:v1:ready", true);
    const count = 1_001;
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(4, "0");
      const digest = "legacy-digest-" + suffix;
      const record = {
        id: "legacy-id-" + suffix, userId: "usr_1", name: "legacy", permissions: ["read"],
        createdAt: NOW, expiresAt: FUTURE, lastUsedAt: null, revokedAt: null,
      };
      await state.storage.put("credential:" + digest, record);
      await state.storage.put("credential-active:" + digest, { expiresAt: FUTURE, revokedAt: null });
    }
    const object = new UserAuthStateDurableObject(state);
    const request = () => object.fetch(post("/credentials/revoke-by-id", {
      id: "legacy-id-1000", revokedAt: NOW,
    }));
    let response = await request();
    expect(response.status).toBe(503);
    let attempts = 0;
    while (response.status === 503 && attempts < 20) {
      await object.alarm();
      response = await request();
      attempts += 1;
    }
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    const row = await state.storage.get<{ revokedAt: string }>("credential:legacy-digest-1000");
    expect(row?.revokedAt).toBe(NOW);
    expect(state.testMetrics.maxRowsPerList).toBeLessThanOrEqual(100);
  });

  it("keeps future revoke-all credentials usable until the fence, then rejects them and preserves newer credentials", async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse(NOW);
    vi.setSystemTime(nowMs);
    try {
      const state = createFakeDurableObjectState();
      const object = new UserAuthStateDurableObject(state);
      const expiresAt = new Date(nowMs + 10_000).toISOString();
      const oldRecord = {
        id: "future-old", userId: "usr_1", name: "old", permissions: ["read"],
        createdAt: NOW, expiresAt, lastUsedAt: null, revokedAt: null,
      };
      await object.fetch(post("/credentials/create", { digest: "future-old-digest", record: oldRecord }));
      const fenceAt = new Date(nowMs + 60_000).toISOString();
      expect((await object.fetch(post("/credentials/revoke-all", { revokedAt: fenceAt }))).status).toBe(204);
      expect(await (await object.fetch(post("/credentials/get", { digest: "future-old-digest" }))).json())
        .toEqual({ record: oldRecord });

      const freshRecord = {
        ...oldRecord, id: "future-new", name: "new",
        expiresAt: new Date(nowMs + 24 * 60 * 60_000).toISOString(),
      };
      await object.fetch(post("/credentials/create", { digest: "future-new-digest", record: freshRecord }));

      vi.setSystemTime(nowMs + 11_000);
      await state.storage.deleteAlarm();
      await object.alarm();
      expect(await state.storage.get("credential:future-old-digest")).toEqual(oldRecord);
      expect(await state.storage.getAlarm()).toBe(nowMs + 60_000);

      vi.setSystemTime(nowMs + 61_000);
      expect(await (await object.fetch(post("/credentials/get", { digest: "future-old-digest" }))).json())
        .toEqual({ record: null });
      await state.storage.deleteAlarm();
      await object.alarm();
      expect(await state.storage.get("credential:future-old-digest")).toBeUndefined();
      expect(await (await object.fetch(post("/credentials/get", { digest: "future-new-digest" }))).json())
        .toEqual({ record: freshRecord });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([1_000, 1_001])("lists %i active credentials in bounded cursor pages", async (count) => {
    const state = createFakeDurableObjectState();
    await seedCredentialRows(state, count);
    state.testMetrics.listCalls = 0;
    state.testMetrics.rowsReturned = 0;
    state.testMetrics.maxRowsPerList = 0;
    const object = new UserAuthStateDurableObject(state);
    let cursor: string | undefined;
    const seen = new Set<string>();
    let pageCount = 0;
    do {
      const response = await object.fetch(post("/credentials/list", cursor ? { cursor } : {}));
      expect(response.status).toBe(200);
      const page = await response.json() as {
        items: Array<{ digest: string }>;
        nextCursor?: string;
      };
      for (const item of page.items) seen.add(item.digest);
      cursor = page.nextCursor;
      pageCount += 1;
    } while (cursor);

    const expectedPages = Math.ceil(count / 100);
    expect(seen.size).toBe(count);
    expect(pageCount).toBe(expectedPages);
    expect(state.testMetrics.listCalls).toBe(expectedPages + Math.floor(count / 100));
    expect(state.testMetrics.rowsReturned).toBe(count + Math.floor((count - 1) / 100));
    expect(state.testMetrics.maxRowsPerList).toBe(100);
  });

  it("revokes one credential by direct ID lookup without scanning a 1001-row list", async () => {
    const state = createFakeDurableObjectState();
    await seedCredentialRows(state, 1_001);
    const object = new UserAuthStateDurableObject(state);
    state.testMetrics.listCalls = 0;
    state.testMetrics.rowsReturned = 0;
    state.testMetrics.maxRowsPerList = 0;

    const response = await object.fetch(post("/credentials/revoke-by-id", {
      id: "credential-1000", revokedAt: NOW,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    expect(state.testMetrics.listCalls).toBe(0);
    expect(await state.storage.get("credential:digest-1000")).toMatchObject({ revokedAt: NOW });
  });

  it.each([1_000, 1_001])("revokes all %i credentials in one atomic metadata update and cleans indexes in bounded batches", async (count) => {
    const state = createFakeDurableObjectState();
    await seedCredentialRows(state, count);
    const object = new UserAuthStateDurableObject(state);
    state.testMetrics.listCalls = 0;
    state.testMetrics.rowsReturned = 0;
    state.testMetrics.maxRowsPerList = 0;

    expect((await object.fetch(post("/credentials/revoke-all", { revokedAt: NOW }))).status).toBe(204);
    expect(state.testMetrics.listCalls).toBe(0);
    expect(await (await object.fetch(post("/credentials/get", { digest: "digest-0000" }))).json())
      .toEqual({ record: null });

    const fresh = {
      id: "credential-fresh", userId: "usr_1", name: "fresh", permissions: ["read"],
      createdAt: NOW, expiresAt: FUTURE, lastUsedAt: null, revokedAt: null,
    };
    expect((await object.fetch(post("/credentials/create", { digest: "digest-fresh", record: fresh }))).status).toBe(204);
    expect((await (await object.fetch(post("/credentials/get", { digest: "digest-fresh" }))).json() as {
      record: unknown;
    }).record).toEqual(fresh);

    let alarmRuns = 0;
    while (alarmRuns < 20 && (await state.storage.get<number>("credential-generation:v1:cleanup-epoch") ?? 0) < 1) {
      await object.alarm();
      alarmRuns += 1;
      expect(state.testMetrics.maxRowsPerList).toBeLessThanOrEqual(100);
    }
    expect(alarmRuns).toBe(Math.ceil(count / 100) + (count % 100 === 0 ? 1 : 0));
    for (let index = 0; index < count; index += 1) {
      const digest = "digest-" + String(index).padStart(4, "0");
      const id = "credential-" + String(index).padStart(4, "0");
      expect(await state.storage.get("credential-active:" + digest)).toBeUndefined();
      expect(await state.storage.get("credential-id:" + encodeURIComponent(id))).toBeUndefined();
    }
    expect(await state.storage.get("credential-active:digest-fresh")).toBeDefined();
    expect(await state.storage.get("credential-id:credential-fresh")).toBe("digest-fresh");
    expect(await state.storage.get("credential:digest-0000")).toBeDefined();
    expect(await state.storage.get("credential-id:credential-0000")).toBeUndefined();
    expect(await state.storage.get("credential-active:digest-0000")).toBeUndefined();
  });
});

describe("UserAuthStateDurableObject transport", () => {
  it("rejects non-POST methods and unknown paths", async () => {
    const object = new UserAuthStateDurableObject(createFakeDurableObjectState());
    expect((await object.fetch(new Request("https://user-auth-state/sessions/get"))).status).toBe(405);
    expect((await object.fetch(post("/nope", {}))).status).toBe(404);
  });

  it("does not let a stale GitHub token reader lock a rotated token revision", async () => {
    const object = new UserAuthStateDurableObject(createFakeDurableObjectState());
    const original = {
      encrypted: { version: 1, keyId: "test", iv: "iv-0", ciphertext: "token-0" },
      accessTokenExpiresAt: "2026-08-01T00:00:00.000Z",
      refreshTokenExpiresAt: "2026-09-01T00:00:00.000Z",
      issuedAt: NOW,
    };
    await object.fetch(post("/github-token/store", original));

    const firstLock = await object.fetch(post("/github-token/lock", {
      lockId: "refresh-a",
      lockUntil: "2026-08-01T00:00:20.000Z",
      now: NOW,
      expectedRevision: 1,
    }));
    expect(await firstLock.json()).toEqual({ acquired: true });

    const rotated = await object.fetch(post("/github-token/rotate", {
      lockId: "refresh-a",
      expectedRevision: 1,
      encrypted: { version: 1, keyId: "test", iv: "iv-1", ciphertext: "token-1" },
      accessTokenExpiresAt: "2026-08-01T01:00:00.000Z",
      refreshTokenExpiresAt: "2026-09-01T00:00:00.000Z",
    }));
    expect(await rotated.json()).toEqual({ stored: true });

    const staleLock = await object.fetch(post("/github-token/lock", {
      lockId: "refresh-b",
      lockUntil: "2026-08-01T00:00:20.000Z",
      now: NOW,
      expectedRevision: 1,
    }));
    expect(await staleLock.json()).toEqual({ acquired: false });
    const { state } = await (await object.fetch(post("/github-token/get", {}))).json() as {
      state: { readonly revision: number; readonly refreshLockId: string | null; readonly encrypted: { readonly ciphertext: string } };
    };
    expect(state).toMatchObject({
      revision: 2,
      refreshLockId: null,
      encrypted: { ciphertext: "token-1" },
    });
  });
});
