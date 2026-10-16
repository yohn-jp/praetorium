import { describe, expect, it } from "vitest";
import type { UserId } from "../src/domain.js";
import {
  createSession,
  resolveSession,
  revokeAllSessionsForUser,
  rotateSession,
} from "../src/session/lifecycle.js";
import { createInMemorySessionStore } from "../src/testing/in-memory-session-store.js";

const NOW = "2026-10-17T00:00:00.000Z";
const USER = "github:4242" as UserId;
const OTHER_USER = "github:5252" as UserId;
const PEPPER = new Uint8Array(32).fill(7);

describe("Gateway session authority", () => {
  it("stores only a keyed digest and returns a session revision for grant binding", async () => {
    const store = createInMemorySessionStore();
    const created = await createSession(store, {
      userId: USER,
      authenticationContext: "github-oauth",
      now: NOW,
      ttlSeconds: 3600,
      pepper: PEPPER,
      concurrentSessionLimit: 5,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.record.sessionRevision).toBe(0);
    expect(created.value.digest).not.toContain(created.value.rawSessionId);
    expect(await resolveSession(store, PEPPER, created.value.rawSessionId, NOW)).toMatchObject({
      ok: true,
      value: { record: { userId: USER, sessionRevision: 0 } },
    });
  });

  it("rejects expired and revoked sessions at their exact boundary", async () => {
    const store = createInMemorySessionStore();
    const created = await createSession(store, {
      userId: USER,
      authenticationContext: "github-oauth",
      now: NOW,
      ttlSeconds: 60,
      pepper: PEPPER,
      concurrentSessionLimit: 5,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(
      await resolveSession(store, PEPPER, created.value.rawSessionId, "2026-10-17T00:01:00.000Z"),
    ).toMatchObject({ ok: false, error: { code: "EXPIRED" } });
    await store.revoke(created.value.digest, NOW);
    expect(await resolveSession(store, PEPPER, created.value.rawSessionId, NOW)).toMatchObject({
      ok: false,
      error: { code: "REVOKED" },
    });
  });

  it("rotates session ids, increments revision, revokes replay, and honors bounded grace", async () => {
    const store = createInMemorySessionStore();
    const first = await createSession(store, {
      userId: USER,
      authenticationContext: "github-oauth",
      now: NOW,
      ttlSeconds: 3600,
      pepper: PEPPER,
      concurrentSessionLimit: 5,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const rotated = await rotateSession(store, {
      digest: first.value.digest,
      record: first.value.record,
      now: NOW,
      ttlSeconds: 3600,
      pepper: PEPPER,
      concurrentSessionLimit: 5,
      graceSeconds: 30,
    });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.value.record.sessionRevision).toBe(1);
    expect(await resolveSession(store, PEPPER, first.value.rawSessionId, NOW)).toMatchObject({
      ok: true,
    });
    expect(
      await resolveSession(store, PEPPER, first.value.rawSessionId, "2026-10-17T00:00:30.000Z"),
    ).toMatchObject({ ok: false, error: { code: "REVOKED" } });
    expect(await resolveSession(store, PEPPER, rotated.value.rawSessionId, NOW)).toMatchObject({
      ok: true,
    });
  });

  it("logout-all revokes only the selected user's active sessions", async () => {
    const store = createInMemorySessionStore();
    const userSession = await createSession(store, {
      userId: USER,
      authenticationContext: "github-oauth",
      now: NOW,
      ttlSeconds: 3600,
      pepper: PEPPER,
      concurrentSessionLimit: 5,
    });
    const otherSession = await createSession(store, {
      userId: OTHER_USER,
      authenticationContext: "github-oauth",
      now: NOW,
      ttlSeconds: 3600,
      pepper: PEPPER,
      concurrentSessionLimit: 5,
    });
    expect(userSession.ok && otherSession.ok).toBe(true);
    if (!userSession.ok || !otherSession.ok) return;

    await revokeAllSessionsForUser(store, USER, NOW);
    expect(await resolveSession(store, PEPPER, userSession.value.rawSessionId, NOW)).toMatchObject({
      ok: false,
      error: { code: "REVOKED" },
    });
    expect(await resolveSession(store, PEPPER, otherSession.value.rawSessionId, NOW)).toMatchObject(
      { ok: true },
    );
  });
});
