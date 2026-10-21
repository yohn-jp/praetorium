const EXPIRY_PREFIX = "ephemeral-expiry:";
const INDEX_READY_KEY = "ephemeral-index:v1:ready";
const INDEX_CURSOR_KEY = "ephemeral-index:v1:cursor";
const INDEX_PAGE_SIZE = 100;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function expiryAt(value: unknown): number | null {
  const outer = object(value);
  const record = object(outer?.record) ?? outer;
  const raw = record?.expiresAt;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanupAt(value: unknown): number | null {
  const record = object(object(value)?.record) ?? object(value);
  const expires = expiryAt(value);
  if (expires === null) return null;
  const rawRevoked = record?.revokedAt;
  const revoked = rawRevoked === null || rawRevoked === undefined
    ? null : typeof rawRevoked === "number" ? rawRevoked
      : typeof rawRevoked === "string" ? Date.parse(rawRevoked) : NaN;
  if (Number.isNaN(revoked)) return null;
  return Math.max(expires, revoked ?? 0);
}

function expiryKey(key: string, at: number): string {
  return `${EXPIRY_PREFIX}${String(Math.trunc(at)).padStart(16, "0")}:${key}`;
}

async function writeExpiryIndex(
  transaction: DurableObjectTransaction,
  key: string,
  previous: unknown,
  next: unknown,
): Promise<void> {
  const previousAt = cleanupAt(previous);
  const nextAt = cleanupAt(next);
  if (previousAt !== null) await transaction.delete(expiryKey(key, previousAt));
  if (nextAt !== null) await transaction.put(expiryKey(key, nextAt), key);
}

async function backfillExpiryIndex(transaction: DurableObjectTransaction, now: number): Promise<boolean> {
  if (await transaction.get<boolean>(INDEX_READY_KEY)) return true;
  const startAfter = await transaction.get<string>(INDEX_CURSOR_KEY);
  const options: DurableObjectListOptions = { limit: INDEX_PAGE_SIZE };
  if (startAfter) options.startAfter = startAfter;
  const rows = await transaction.list<unknown>(options);
  for (const [key, value] of rows) {
    if (key.startsWith("oauth-client:") || key.startsWith(EXPIRY_PREFIX) ||
        key === INDEX_READY_KEY || key === INDEX_CURSOR_KEY) continue;
    const at = cleanupAt(value);
    if (at === null) continue;
    if (at > now) await transaction.put(expiryKey(key, at), key);
    else await transaction.delete(key);
  }
  if (rows.size < INDEX_PAGE_SIZE) {
    await transaction.put(INDEX_READY_KEY, true);
    await transaction.delete(INDEX_CURSOR_KEY);
    return true;
  }
  const last = [...rows.keys()].at(-1);
  if (last) await transaction.put(INDEX_CURSOR_KEY, last);
  await transaction.setAlarm(now + 1_000);
  return false;
}

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

  private async scheduleGc(at: number): Promise<void> {
    const next = Math.max(Date.now() + 1, at);
    const current = await this.state.storage.getAlarm();
    if (current === null || current > next) await this.state.storage.setAlarm(next);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const ready = await this.state.storage.transaction((transaction) => backfillExpiryIndex(transaction, now));
    if (!ready) {
      await this.scheduleGc(now + 1_000);
      return;
    }
    const due = await this.state.storage.list<string>({ prefix: EXPIRY_PREFIX, limit: INDEX_PAGE_SIZE });
    let processed = 0;
    for (const [indexKey, key] of due) {
      const at = Number(indexKey.slice(EXPIRY_PREFIX.length).split(":", 1)[0]);
      if (!Number.isSafeInteger(at) || at > now) break;
      await this.state.storage.transaction(async (transaction) => {
        const current = await transaction.get(key);
        const nextAt = current === undefined ? null : cleanupAt(current);
        if (nextAt !== null && nextAt > now) {
          await transaction.delete(indexKey);
          await transaction.put(expiryKey(key, nextAt), key);
        } else {
          await transaction.delete(indexKey);
          await transaction.delete(key);
        }
      });
      processed += 1;
    }
    const remaining = await this.state.storage.list({ prefix: EXPIRY_PREFIX, limit: 1 });
    const firstKey = remaining.keys().next().value as string | undefined;
    if (!firstKey) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const nextAt = Number(firstKey.slice(EXPIRY_PREFIX.length).split(":", 1)[0]);
    await this.scheduleGc(processed === INDEX_PAGE_SIZE && nextAt <= now
      ? now + 100
      : Number.isSafeInteger(nextAt) ? nextAt : now + 60_000);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const url = new URL(request.url);

    if (url.pathname === "/save") {
      const { key, record } = (await request.json()) as { key: string; record: unknown };
      if (typeof key !== "string" || key.length > 256) return new Response("invalid key", { status: 400 });
      if (key.startsWith("oauth-client:")) {
        await this.state.storage.put(key, record);
        return new Response(null, { status: 204 });
      }
      if (!/^(?:login|handoff|admin-handoff|oauth-code):[A-Za-z0-9_.:-]{1,160}$/u.test(key) ||
          cleanupAt(record) === null) return new Response("invalid expiring record", { status: 400 });
      const ready = await this.state.storage.transaction(async (transaction) => {
        const indexed = await backfillExpiryIndex(transaction, Date.now());
        const previous = await transaction.get(key);
        await transaction.put(key, record);
        await writeExpiryIndex(transaction, key, previous, record);
        return indexed;
      });
      const at = cleanupAt(record);
      if (at !== null) await this.scheduleGc(ready ? at : Date.now() + 1_000);
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
      if (typeof key !== "string" || key.length > 256 || key.startsWith("oauth-client:")) {
        return new Response("invalid key", { status: 400 });
      }
      const record = await this.state.storage.transaction(async (transaction) => {
        const current = await transaction.get(key);
        if (current !== undefined) {
          const at = cleanupAt(current);
          if (at !== null) await transaction.delete(expiryKey(key, at));
          await transaction.delete(key);
        }
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
      const expiresAt = now + 24 * 3600_000;
      const claimed = await this.state.storage.transaction(async (tx) => {
        const existing = await tx.get<{ claimId: string; expiresAt: number }>(key);
        if (url.pathname === "/release-dispatch/release") {
          if (!existing || existing.claimId !== claimId) return false;
          await tx.delete(key);
          await writeExpiryIndex(tx, key, existing, null);
          return true;
        }
        if (existing && existing.expiresAt > now) return false;
        const next = { claimId, expiresAt };
        await tx.put(key, next);
        await writeExpiryIndex(tx, key, existing, next);
        return true;
      });
      if (claimed && url.pathname.endsWith("/claim")) await this.scheduleGc(expiresAt);
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
      if (cleanupAt({ digest, record }) === null) return new Response("invalid refresh expiry", { status: 400 });
      const created = await this.state.storage.transaction(async (transaction) => {
        if ((await transaction.get(key)) !== undefined) return false;
        const next = { digest, record };
        await transaction.put(key, next);
        await writeExpiryIndex(transaction, key, null, next);
        return true;
      });
      if (!created) {
        return new Response("conflict", { status: 409 });
      }
      const at = cleanupAt({ digest, record });
      if (at !== null) await this.scheduleGc(at);
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
        const next = {
          ...entry,
          record: { ...entry.record, revokedAt },
        };
        await transaction.put(key, next);
        await writeExpiryIndex(transaction, key, entry, next);
        return true;
      });
      if (revoked) {
        const entry = await this.state.storage.get<{ digest: string; record: { expiresAt: string; revokedAt: string | null } }>(key);
        const at = entry ? cleanupAt(entry) : null;
        if (at !== null) await this.scheduleGc(at);
      }
      return Response.json({ revoked });
    }

    return new Response("not found", { status: 404 });
  }
}
