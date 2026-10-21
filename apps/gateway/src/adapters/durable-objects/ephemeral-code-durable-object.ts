/**
 * Generic single-use keyed record store. Backs both the OAuth login-attempt
 * store (#17) and the browser handoff-code store (#22): both need atomic
 * "read once, then it's gone" semantics, and Cloudflare serializes requests
 * to a single Durable Object instance, so a `get` immediately followed by a
 * `delete` here can never race with a concurrent `/consume` for the same
 * key landing on the same instance.
 */
export class EphemeralCodeDurableObject implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const url = new URL(request.url);

    if (url.pathname === "/save") {
      const { key, record } = (await request.json()) as { key: string; record: unknown };
      await this.state.storage.put(key, record);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/get") {
      const { key } = (await request.json()) as { key: string };
      if (!key.startsWith("oauth-client:")) return new Response("not found", { status: 404 });
      const record = await this.state.storage.get(key);
      return Response.json({ record: record ?? null });
    }

    if (url.pathname === "/consume") {
      const { key } = (await request.json()) as { key: string };
      const record = await this.state.storage.transaction(async (transaction) => {
        const current = await transaction.get(key);
        if (current !== undefined) await transaction.delete(key);
        return current;
      });
      return Response.json({ record: record ?? null });
    }

    // Atomic short-lived operator dispatch deduplication. This DO is *not* a
    // release-state machine: GitHub Actions owns builds and Control Plane owns
    // admission/Stable. Ambiguous network failures retain this claim.
    if (url.pathname === "/release-dispatch/claim" || url.pathname === "/release-dispatch/release") {
      const { key, claimId, now } = (await request.json()) as {
        key: string; claimId: string; now: number;
      };
      if (!/^release-dispatch:[A-Za-z0-9_-]{43}$/u.test(key) ||
          !/^[0-9a-f-]{36}$/u.test(claimId) ||
          !Number.isSafeInteger(now) || Math.abs(now-Date.now()) > 120_000)
        return new Response("invalid dispatch claim", { status: 400 });
      const claimed = await this.state.storage.transaction(async (tx) => {
        const existing = await tx.get<{ claimId: string; expiresAt: number }>(key);
        if (url.pathname === "/release-dispatch/release") {
          if (!existing || existing.claimId !== claimId) return false;
          await tx.delete(key);
          return true;
        }
        if (existing && existing.expiresAt > now) return false;
        await tx.put(key, { claimId, expiresAt: now + 24 * 3600_000 });
        return true;
      });
      return Response.json(url.pathname.endsWith("/claim")
        ? { claimed } : { released: claimed });
    }

    if (url.pathname === "/refresh/create") {
      const { credentialId, digest, record } = (await request.json()) as {
        credentialId: string;
        digest: string;
        record: unknown;
      };
      const key = `refresh:${credentialId}`;
      const created = await this.state.storage.transaction(async (transaction) => {
        if ((await transaction.get(key)) !== undefined) return false;
        await transaction.put(key, { digest, record });
        return true;
      });
      if (!created) {
        return new Response("conflict", { status: 409 });
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/refresh/get") {
      const { credentialId } = (await request.json()) as { credentialId: string };
      const entry = await this.state.storage.get<{ digest: string; record: unknown }>(
        `refresh:${credentialId}`,
      );
      return Response.json({ entry: entry ?? null });
    }

    if (url.pathname === "/refresh/rotate") {
      const { credentialId, currentDigest, nextDigest, now } = (await request.json()) as {
        credentialId: string;
        currentDigest: string;
        nextDigest: string;
        now: string;
      };
      const key = `refresh:${credentialId}`;
      const rotated = await this.state.storage.transaction(async (transaction) => {
        const entry = await transaction.get<{
          digest: string;
          record: { expiresAt: string; revokedAt: string | null };
        }>(key);
        if (
          !entry ||
          entry.digest !== currentDigest ||
          entry.record.revokedAt !== null ||
          new Date(entry.record.expiresAt).getTime() <= new Date(now).getTime()
        ) {
          return false;
        }
        await transaction.put(key, { ...entry, digest: nextDigest });
        return true;
      });
      return Response.json({ rotated });
    }

    if (url.pathname === "/refresh/revoke") {
      const { credentialId, digest, revokedAt } = (await request.json()) as {
        credentialId: string;
        digest: string;
        revokedAt: string;
      };
      const key = `refresh:${credentialId}`;
      const revoked = await this.state.storage.transaction(async (transaction) => {
        const entry = await transaction.get<{
          digest: string;
          record: { revokedAt: string | null };
        }>(key);
        if (!entry || entry.digest !== digest || entry.record.revokedAt !== null) {
          return false;
        }
        await transaction.put(key, {
          ...entry,
          record: { ...entry.record, revokedAt },
        });
        return true;
      });
      return Response.json({ revoked });
    }

    return new Response("not found", { status: 404 });
  }
}
