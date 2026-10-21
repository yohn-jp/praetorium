import { afterEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { createSession, type UserId } from "@praetorium/auth";
import { createDurableObjectSessionStore } from "../src/adapters/durable-objects/user-auth-state-client.js";

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
});
