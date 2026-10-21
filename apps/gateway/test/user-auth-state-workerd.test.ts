import { afterEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { createSession, type McpCredentialRecord, type UserId } from "@praetorium/auth";
import {
  createDurableObjectMcpCredentialStore,
  createDurableObjectSessionStore,
} from "../src/adapters/durable-objects/user-auth-state-client.js";

describe("UserAuthStateDurableObject in workerd", () => {
  let miniflare: Miniflare | undefined;

  afterEach(async () => {
    await miniflare?.dispose();
    miniflare = undefined;
  });

  it("serializes simultaneous admission at a limit of one", async () => {
    const root = process.cwd();
    const bundle = await build({
      entryPoints: [`${root}/test/workerd-user-auth-worker.ts`],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
    });
    miniflare = new Miniflare({
      name: "praetorium-user-auth-state-test",
      script: bundle.outputFiles[0]!.text,
      modules: true,
      modulesRoot: root,
      compatibilityDate: "2026-07-30",
      durableObjects: {
        USER_AUTH_STATE: { className: "UserAuthStateDurableObject", useSQLite: true },
        EPHEMERAL_CODES: { className: "EphemeralCodeDurableObject", useSQLite: true },
      },
    });
    const namespace = await miniflare.getDurableObjectNamespace("USER_AUTH_STATE");
    const digests = new Map<string, UserId>();
    const store = createDurableObjectSessionStore(namespace, {
      async set(digest, userId) { digests.set(digest, userId); },
      async get(digest) { return digests.get(digest) ?? null; },
      async delete(digest) { digests.delete(digest); },
    });
    const now = new Date().toISOString();
    const create = () => createSession(store, {
      userId: "213253858" as UserId,
      authenticationContext: "github-oauth",
      now,
      ttlSeconds: 3600,
      pepper: new Uint8Array(32).fill(17),
      concurrentSessionLimit: 1,
    });

    const results = await Promise.all([create(), create()]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok &&
      result.error.code === "CONCURRENT_SESSION_LIMIT_EXCEEDED")).toHaveLength(1);
    await expect(store.countActiveForUser("213253858" as UserId, now)).resolves.toBe(1);
  });

  it("runs real workerd expiry alarms for auth and one-use rows while retaining OAuth clients", async () => {
    const root = process.cwd();
    const bundle = await build({
      entryPoints: [`${root}/test/workerd-user-auth-worker.ts`],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
    });
    miniflare = new Miniflare({
      name: "praetorium-auth-expiry-test",
      script: bundle.outputFiles[0]!.text,
      modules: true,
      modulesRoot: root,
      compatibilityDate: "2026-07-30",
      durableObjects: {
        USER_AUTH_STATE: { className: "UserAuthStateDurableObject", useSQLite: true },
        EPHEMERAL_CODES: { className: "EphemeralCodeDurableObject", useSQLite: true },
      },
    });
    const userNamespace = await miniflare.getDurableObjectNamespace("USER_AUTH_STATE");
    const ephemeralNamespace = await miniflare.getDurableObjectNamespace("EPHEMERAL_CODES");
    const userId = "213253858" as UserId;
    const index = new Map<string, UserId>();
    const store = createDurableObjectSessionStore(userNamespace, {
      async set(digest, id) { index.set(digest, id); },
      async get(digest) { return index.get(digest) ?? null; },
      async delete(digest) { index.delete(digest); },
    });
    const now = Date.now();
    const expiresAt = new Date(now + 500).toISOString();
    const digest = "workerd-expiring-session";
    const record = {
      userId, sessionRevision: 0, createdAt: new Date(now).toISOString(), expiresAt,
      lastActivityBucket: new Date(now).toISOString(), authenticationContext: "github-oauth" as const,
      rotatedFromDigest: null, revokedAt: null,
    };
    await store.create(digest, record);
    await expect(store.get(digest)).resolves.toEqual(record);

    const ephemeral = ephemeralNamespace.get(ephemeralNamespace.idFromName("workerd-expiry"));
    const save = (key: string, value: unknown) => ephemeral.fetch("https://ephemeral-code/save", {
      method: "POST", body: JSON.stringify({ key, record: value }),
    });
    expect((await save("login:workerd-expiry", { expiresAt })).status).toBe(204);
    expect((await save("oauth-client:permanent", {
      clientId: "permanent", redirectUris: ["https://client.example/callback"],
    })).status).toBe(204);

    const deadline = Date.now() + 5_000;
    let cleaned = false;
    while (Date.now() < deadline) {
      if (await store.get(digest) === null) {
        cleaned = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(cleaned).toBe(true);
    expect(index.has(digest)).toBe(false);

    const consumed = await ephemeral.fetch("https://ephemeral-code/consume", {
      method: "POST", body: JSON.stringify({ key: "login:workerd-expiry" }),
    });
    expect(await consumed.json()).toEqual({ record: null });
    const permanent = await ephemeral.fetch("https://ephemeral-code/get", {
      method: "POST", body: JSON.stringify({ key: "oauth-client:permanent" }),
    });
    expect(await permanent.json()).toEqual({ record: {
      clientId: "permanent", redirectUris: ["https://client.example/callback"],
    } });
  });

  it("revoke-by-ID and revoke-all take effect in real workerd storage while newer credentials survive", async () => {
    const root = process.cwd();
    const bundle = await build({
      entryPoints: [`${root}/test/workerd-user-auth-worker.ts`],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
    });
    miniflare = new Miniflare({
      name: "praetorium-credential-revoke-test",
      script: bundle.outputFiles[0]!.text,
      modules: true,
      modulesRoot: root,
      compatibilityDate: "2026-07-30",
      durableObjects: {
        USER_AUTH_STATE: { className: "UserAuthStateDurableObject", useSQLite: true },
        EPHEMERAL_CODES: { className: "EphemeralCodeDurableObject", useSQLite: true },
      },
    });
    const namespace = await miniflare.getDurableObjectNamespace("USER_AUTH_STATE");
    const routes = new Map<string, UserId>();
    const store = createDurableObjectMcpCredentialStore(namespace, {
      async set(digest, userId) { routes.set(digest, userId); },
      async get(digest) { return routes.get(digest) ?? null; },
      async delete(digest) { routes.delete(digest); },
    });
    const userId = "213253858" as UserId;
    const now = new Date().toISOString();
    const record = (id: string, name: string): McpCredentialRecord => ({
      id: id as McpCredentialRecord["id"],
      userId,
      sessionRevision: 0,
      repositoryId: 91,
      instanceId: "instance_workerd",
      runtimeEpoch: 1,
      name,
      permissions: ["read"],
      createdAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    });

    const individuallyRevoked = record("workerd-id-one", "one");
    await store.create("workerd-digest-one", individuallyRevoked);
    await expect(store.get("workerd-digest-one")).resolves.toEqual(individuallyRevoked);
    await expect(store.revokeById(userId, individuallyRevoked.id, now)).resolves.toBe(true);
    await expect(store.get("workerd-digest-one")).resolves.toMatchObject({ revokedAt: now });

    const bulkRevoked = record("workerd-id-bulk", "bulk");
    await store.create("workerd-digest-bulk", bulkRevoked);
    await store.revokeAllForUser(userId, now);
    await expect(store.get("workerd-digest-bulk")).resolves.toBeNull();

    const afterBulk = record("workerd-id-after-bulk", "after-bulk");
    await store.create("workerd-digest-after-bulk", afterBulk);
    await expect(store.get("workerd-digest-after-bulk")).resolves.toEqual(afterBulk);
    const listed = await store.listForUser(userId);
    expect(listed.items.map(item => [item.digest, item.record.id, item.record.revokedAt]).sort())
      .toEqual([
        ["workerd-digest-after-bulk", afterBulk.id, null],
        ["workerd-digest-bulk", bulkRevoked.id, now],
        ["workerd-digest-one", individuallyRevoked.id, now],
      ].sort());
  });
});
