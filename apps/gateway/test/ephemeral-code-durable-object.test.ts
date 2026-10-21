import { describe, expect, it } from "vitest";
import { EphemeralCodeDurableObject } from "../src/adapters/durable-objects/ephemeral-code-durable-object.js";
import { createFakeDurableObjectState } from "./testing/fake-durable-object-state.js";

function post(path: string, body: unknown): Request {
  return new Request(`https://ephemeral-code${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("EphemeralCodeDurableObject", () => {
  it("saves and consumes a record exactly once", async () => {
    const object = new EphemeralCodeDurableObject(createFakeDurableObjectState());

    await object.fetch(post("/save", { key: "login:state-1", record: { foo: "bar" } }));

    const first = await object.fetch(post("/consume", { key: "login:state-1" }));
    expect(await first.json()).toEqual({ record: { foo: "bar" } });

    const second = await object.fetch(post("/consume", { key: "login:state-1" }));
    expect(await second.json()).toEqual({ record: null });
  });

  it("returns null consuming a key that was never saved", async () => {
    const object = new EphemeralCodeDurableObject(createFakeDurableObjectState());
    const response = await object.fetch(post("/consume", { key: "unknown" }));
    expect(await response.json()).toEqual({ record: null });
  });

  it("uses a storage transaction so concurrent consumes produce one winner", async () => {
    const object = new EphemeralCodeDurableObject(createFakeDurableObjectState());
    await object.fetch(post("/save", { key: "handoff:code-1", record: { instanceId: "ins_1" } }));

    const responses = await Promise.all([
      object.fetch(post("/consume", { key: "handoff:code-1" })),
      object.fetch(post("/consume", { key: "handoff:code-1" })),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies.filter((body) => (body as { record: unknown }).record !== null)).toHaveLength(1);
  });

  it("compares and rotates one refresh credential chain before revocation", async () => {
    const object = new EphemeralCodeDurableObject(createFakeDurableObjectState());
    const credentialId = "opaque-refresh-locator";
    await object.fetch(
      post("/refresh/create", {
        credentialId,
        digest: "digest-before",
        record: {
          expiresAt: "2099-01-01T00:00:00.000Z",
          revokedAt: null,
        },
      }),
    );

    const first = await object.fetch(
      post("/refresh/rotate", {
        credentialId,
        currentDigest: "digest-before",
        nextDigest: "digest-after",
        now: "2026-08-01T00:00:00.000Z",
      }),
    );
    expect(await first.json()).toEqual({ rotated: true });
    const replay = await object.fetch(
      post("/refresh/rotate", {
        credentialId,
        currentDigest: "digest-before",
        nextDigest: "digest-replay",
        now: "2026-08-01T00:00:00.000Z",
      }),
    );
    expect(await replay.json()).toEqual({ rotated: false });

    const revoked = await object.fetch(
      post("/refresh/revoke", {
        credentialId,
        digest: "digest-after",
        revokedAt: "2026-08-01T00:00:01.000Z",
      }),
    );
    expect(await revoked.json()).toEqual({ revoked: true });
    const afterRevoke = await object.fetch(
      post("/refresh/rotate", {
        credentialId,
        currentDigest: "digest-after",
        nextDigest: "digest-late",
        now: "2026-08-01T00:00:02.000Z",
      }),
    );
    expect(await afterRevoke.json()).toEqual({ rotated: false });
  });

  it("allows only one concurrent refresh rotation for the current digest", async () => {
    const object = new EphemeralCodeDurableObject(createFakeDurableObjectState());
    const credentialId = "opaque-refresh-locator";
    await object.fetch(
      post("/refresh/create", {
        credentialId,
        digest: "digest-before",
        record: { expiresAt: "2099-01-01T00:00:00.000Z", revokedAt: null },
      }),
    );

    const responses = await Promise.all([
      object.fetch(
        post("/refresh/rotate", {
          credentialId,
          currentDigest: "digest-before",
          nextDigest: "digest-after-1",
          now: "2026-08-01T00:00:00.000Z",
        }),
      ),
      object.fetch(
        post("/refresh/rotate", {
          credentialId,
          currentDigest: "digest-before",
          nextDigest: "digest-after-2",
          now: "2026-08-01T00:00:00.000Z",
        }),
      ),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies.filter((body) => (body as { rotated: boolean }).rotated)).toHaveLength(1);
  });

  it("atomically claims one Release dispatch and releases only its owner", async () => {
    const object = new EphemeralCodeDurableObject(createFakeDurableObjectState());
    const now = Date.now();
    const key = "release-dispatch:" + "a".repeat(43);
    const body = { key, now, claimId: "00000000-0000-4000-a000-000000000001" };
    const responses = await Promise.all([
      object.fetch(post("/release-dispatch/claim", body)),
      object.fetch(post("/release-dispatch/claim",
        { ...body, claimId: "00000000-0000-4000-a000-000000000002" })),
    ]);
    const results = await Promise.all(responses.map(r => r.json()));
    expect(results.filter(x => (x as {claimed:boolean}).claimed)).toHaveLength(1);
    const owner = (results[0] as {claimed:boolean}).claimed
      ? body.claimId : "00000000-0000-4000-a000-000000000002";
    const other = owner === body.claimId
      ? "00000000-0000-4000-a000-000000000002" : body.claimId;
    expect(await (await object.fetch(post("/release-dispatch/release",
      { key, now, claimId: other }))).json()).toEqual({released:false});
    expect(await (await object.fetch(post("/release-dispatch/release",
      { key, now, claimId: owner }))).json()).toEqual({released:true});
    expect(await (await object.fetch(post("/release-dispatch/claim", body))).json())
      .toEqual({claimed:true});
    expect((await object.fetch(post("/release-dispatch/claim",
      {key:"release-dispatch:invalid",now,claimId:owner}))).status).toBe(400);
  });

  it("rejects non-POST methods and unknown paths", async () => {
    const object = new EphemeralCodeDurableObject(createFakeDurableObjectState());
    expect((await object.fetch(new Request("https://ephemeral-code/save"))).status).toBe(405);
    expect((await object.fetch(post("/nope", {}))).status).toBe(404);
  });
});
