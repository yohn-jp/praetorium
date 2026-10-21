const SESSION_PREFIX = "session:";
const CREDENTIAL_PREFIX = "credential:";
const SESSION_ACTIVE_PREFIX = "session-active:";
const CREDENTIAL_ACTIVE_PREFIX = "credential-active:";
const AUTH_EXPIRY_PREFIX = "auth-expiry:";
const SESSION_INDEX_READY_KEY = "session-index:v1:ready";
const SESSION_INDEX_CURSOR_KEY = "session-index:v1:cursor";
const CREDENTIAL_INDEX_READY_KEY = "credential-index:v1:ready";
const CREDENTIAL_INDEX_CURSOR_KEY = "credential-index:v1:cursor";
const GITHUB_TOKEN_KEY = "github-user-token";
const INDEX_PAGE_SIZE = 100;
const MAX_INDEX_PAGES = 10;

type AuthRecord = { readonly expiresAt: string; readonly revokedAt: string | null };
type IndexResult = { readonly ready: boolean };

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanupAt(record: AuthRecord): number | null {
  const expires = timestamp(record.expiresAt);
  if (expires === null) return null;
  const revoked = record.revokedAt === null ? null : timestamp(record.revokedAt);
  if (record.revokedAt !== null && revoked === null) return null;
  return Math.max(expires, revoked ?? 0);
}

function expiryKey(kind: "session" | "credential", digest: string, at: number): string {
  return `${AUTH_EXPIRY_PREFIX}${String(Math.trunc(at)).padStart(16, "0")}:${kind}:${digest}`;
}

async function writeExpiryIndex(
  transaction: DurableObjectTransaction,
  kind: "session" | "credential",
  digest: string,
  previous: AuthRecord | null,
  next: AuthRecord,
): Promise<void> {
  const previousAt = previous ? cleanupAt(previous) : null;
  const nextAt = cleanupAt(next);
  if (previousAt !== null) await transaction.delete(expiryKey(kind, digest, previousAt));
  if (nextAt !== null) {
    await transaction.put(expiryKey(kind, digest, nextAt), { kind, digest });
  }
}

async function backfillIndex(
  transaction: DurableObjectTransaction,
  kind: "session" | "credential",
  now: string,
): Promise<IndexResult> {
  const session = kind === "session";
  const recordPrefix = session ? SESSION_PREFIX : CREDENTIAL_PREFIX;
  const activePrefix = session ? SESSION_ACTIVE_PREFIX : CREDENTIAL_ACTIVE_PREFIX;
  const readyKey = session ? SESSION_INDEX_READY_KEY : CREDENTIAL_INDEX_READY_KEY;
  const cursorKey = session ? SESSION_INDEX_CURSOR_KEY : CREDENTIAL_INDEX_CURSOR_KEY;
  if (await transaction.get<boolean>(readyKey)) return { ready: true };
  const startAfter = await transaction.get<string>(cursorKey);
  const options: DurableObjectListOptions = { prefix: recordPrefix, limit: INDEX_PAGE_SIZE };
  if (startAfter) options.startAfter = startAfter;
  const rows = await transaction.list<Record<string, unknown>>(options);
  for (const [key, unknownRecord] of rows) {
    const digest = key.slice(recordPrefix.length);
    const record = unknownRecord as AuthRecord;
    const expiresAt = timestamp(record.expiresAt);
    if (expiresAt === null || !(record.revokedAt === null || timestamp(record.revokedAt) !== null)) {
      continue;
    }
    if (isActiveRecord(record, now)) {
      await transaction.put(`${activePrefix}${digest}`, {
        expiresAt: record.expiresAt, revokedAt: record.revokedAt,
      });
    }
    const at = cleanupAt(record);
    if (at !== null && at > Date.parse(now)) {
      await transaction.put(expiryKey(kind, digest, at), { kind, digest });
    } else if (at !== null) {
      await transaction.delete(key);
      await transaction.delete(`${activePrefix}${digest}`);
    }
  }
  if (rows.size < INDEX_PAGE_SIZE) {
    await transaction.put(readyKey, true);
    await transaction.delete(cursorKey);
    return { ready: true };
  }
  const last = [...rows.keys()].at(-1);
  if (last) await transaction.put(cursorKey, last);
  return { ready: false };
}

function isActiveRecord(
  record: { readonly expiresAt: string; readonly revokedAt: string | null },
  now: string,
): boolean {
  const nowMs = new Date(now).getTime();
  const notRevoked = !record.revokedAt || new Date(record.revokedAt).getTime() > nowMs;
  const notExpired = new Date(record.expiresAt).getTime() > nowMs;
  return notRevoked && notExpired;
}

/**
 * Authoritative per-user store for browser sessions (#18) and MCP
 * credentials (#19). One instance per user (`idFromName(userId)`) gives
 * strong consistency scoped exactly where it matters: the concurrent-
 * session limit and revocation must never race within a single user's
 * requests, and Cloudflare serializes all requests to one Durable Object
 * instance.
 */
export class UserAuthStateDurableObject implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  private async scheduleGc(at: number): Promise<void> {
    const next = Math.max(Date.now() + 1, at);
    const current = await this.state.storage.getAlarm();
    if (current === null || current > next) await this.state.storage.setAlarm(next);
  }

  private async scheduleMigration(transaction: DurableObjectTransaction): Promise<void> {
    await transaction.setAlarm(Date.now() + 1_000);
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const ready = await this.state.storage.transaction(async (transaction) => {
      const sessions = await backfillIndex(transaction, "session", now);
      const credentials = await backfillIndex(transaction, "credential", now);
      return sessions.ready && credentials.ready;
    });
    if (!ready) {
      await this.scheduleGc(nowMs + 1_000);
      return;
    }

    const entries = await this.state.storage.list<{ kind: "session" | "credential"; digest: string }>({
      prefix: AUTH_EXPIRY_PREFIX,
      limit: INDEX_PAGE_SIZE,
    });
    let processed = 0;
    for (const [indexKey, locator] of entries) {
      const at = Number(indexKey.slice(AUTH_EXPIRY_PREFIX.length).split(":", 1)[0]);
      if (!Number.isSafeInteger(at) || at > nowMs) break;
      const recordPrefix = locator.kind === "session" ? SESSION_PREFIX : CREDENTIAL_PREFIX;
      const activePrefix = locator.kind === "session" ? SESSION_ACTIVE_PREFIX : CREDENTIAL_ACTIVE_PREFIX;
      const recordKey = recordPrefix + locator.digest;
      await this.state.storage.transaction(async (transaction) => {
        const current = await transaction.get<AuthRecord>(recordKey);
        const nextAt = current ? cleanupAt(current) : null;
        if (nextAt !== null && nextAt > nowMs) {
          await transaction.delete(indexKey);
          await transaction.put(expiryKey(locator.kind, locator.digest, nextAt), locator);
          return;
        }
        await transaction.delete(indexKey);
        await transaction.delete(recordKey);
        await transaction.delete(`${activePrefix}${locator.digest}`);
      });
      processed += 1;
    }

    const remaining = await this.state.storage.list({ prefix: AUTH_EXPIRY_PREFIX, limit: 1 });
    const firstKey = remaining.keys().next().value as string | undefined;
    if (!firstKey) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const nextAt = Number(firstKey.slice(AUTH_EXPIRY_PREFIX.length).split(":", 1)[0]);
    await this.scheduleGc(processed === INDEX_PAGE_SIZE && nextAt <= nowMs
      ? nowMs + 100
      : Number.isSafeInteger(nextAt) ? nextAt : nowMs + 60_000);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const body = (await request.json()) as Record<string, unknown>;

    switch (url.pathname) {
      case "/sessions/create": {
        const { digest, record } = body as { digest: string; record: AuthRecord };
        await this.state.storage.transaction(async (transaction) => {
          await transaction.put(`${SESSION_PREFIX}${digest}`, record);
          if (isActiveRecord(record, new Date().toISOString())) {
            await transaction.put(`${SESSION_ACTIVE_PREFIX}${digest}`, {
              expiresAt: record.expiresAt, revokedAt: record.revokedAt,
            });
          }
          await writeExpiryIndex(transaction, "session", digest, null, record);
        });
        const at = cleanupAt(record);
        if (at !== null) await this.scheduleGc(at);
        return new Response(null, { status: 204 });
      }
      case "/sessions/create-within-limit": {
        const { digest, record, concurrentSessionLimit, now } = body as {
          digest: string; record: AuthRecord; concurrentSessionLimit: number; now: string;
        };
        if (!Number.isSafeInteger(concurrentSessionLimit) || concurrentSessionLimit < 1 ||
            timestamp(now) === null || timestamp(record?.expiresAt) === null) {
          return Response.json({ error: "invalid session admission" }, { status: 400 });
        }
        const result = await this.state.storage.transaction(async (transaction) => {
          const migration = await backfillIndex(transaction, "session", now);
          if (!migration.ready) {
            await this.scheduleMigration(transaction);
            return { created: false, unavailable: true };
          }
          let activeCount = 0;
          let startAfter: string | undefined;
          let complete = false;
          for (let page = 0; page < MAX_INDEX_PAGES; page += 1) {
            const options: DurableObjectListOptions = {
              prefix: SESSION_ACTIVE_PREFIX, limit: INDEX_PAGE_SIZE,
            };
            if (startAfter) options.startAfter = startAfter;
            const active = await transaction.list<AuthRecord>(options);
            for (const [key, indexed] of active) {
              if (isActiveRecord(indexed, now)) {
                activeCount += 1;
                if (activeCount >= concurrentSessionLimit) {
                  return { created: false, unavailable: false };
                }
              } else {
                await transaction.delete(key);
              }
            }
            if (active.size < INDEX_PAGE_SIZE) {
              complete = true;
              break;
            }
            startAfter = [...active.keys()].at(-1);
          }
          if (!complete) {
            await this.scheduleMigration(transaction);
            return { created: false, unavailable: true };
          }
          await transaction.put(`${SESSION_PREFIX}${digest}`, record);
          await transaction.put(`${SESSION_ACTIVE_PREFIX}${digest}`, {
            expiresAt: record.expiresAt, revokedAt: record.revokedAt,
          });
          await writeExpiryIndex(transaction, "session", digest, null, record);
          return { created: true, unavailable: false };
        });
        if (result.unavailable) {
          await this.scheduleGc(Date.now() + 1_000);
          return Response.json({ error: "session index is being prepared" }, { status: 503 });
        }
        if (result.created) {
          const at = cleanupAt(record);
          if (at !== null) await this.scheduleGc(at);
        }
        return Response.json({ created: result.created });
      }
      case "/sessions/get": {
        const { digest } = body as { digest: string };
        const record = await this.state.storage.get(`${SESSION_PREFIX}${digest}`);
        return Response.json({ record: record ?? null });
      }
      case "/sessions/touch": {
        const { digest, lastActivityBucket, expiresAt } = body as {
          digest: string;
          lastActivityBucket: string;
          expiresAt: string;
        };
        await this.state.storage.transaction(async (transaction) => {
          const key = `${SESSION_PREFIX}${digest}`;
          const existing = await transaction.get<Record<string, unknown>>(key);
          if (!existing) return;
          const previous = existing as AuthRecord;
          const updated = { ...existing, lastActivityBucket, expiresAt } as unknown as AuthRecord;
          await transaction.put(key, updated);
          await writeExpiryIndex(transaction, "session", digest, previous, updated);
          const activeKey = `${SESSION_ACTIVE_PREFIX}${digest}`;
          if (isActiveRecord(updated, new Date().toISOString())) {
            await transaction.put(activeKey, { expiresAt, revokedAt: updated.revokedAt });
          } else {
            await transaction.delete(activeKey);
          }
        });
        const alarm = Date.parse(expiresAt);
        if (Number.isFinite(alarm)) await this.scheduleGc(alarm);
        return new Response(null, { status: 204 });
      }
      case "/sessions/revoke": {
        const { digest, revokedAt } = body as { digest: string; revokedAt: string };
        await this.state.storage.transaction(async (transaction) => {
          const key = `${SESSION_PREFIX}${digest}`;
          const existing = await transaction.get<Record<string, unknown>>(key);
          if (!existing) return;
          const previous = existing as AuthRecord;
          const updated = { ...existing, revokedAt } as AuthRecord;
          await transaction.put(key, updated);
          await writeExpiryIndex(transaction, "session", digest, previous, updated);
          const activeKey = `${SESSION_ACTIVE_PREFIX}${digest}`;
          if (isActiveRecord(updated, new Date().toISOString())) {
            await transaction.put(activeKey, { expiresAt: updated.expiresAt, revokedAt });
          } else {
            await transaction.delete(activeKey);
          }
        });
        const record = await this.state.storage.get<AuthRecord>(`${SESSION_PREFIX}${digest}`);
        const at = record ? cleanupAt(record) : null;
        if (at !== null) await this.scheduleGc(at);
        return new Response(null, { status: 204 });
      }
      case "/sessions/revoke-all": {
        const { revokedAt } = body as { revokedAt: string };
        const applied = await this.state.storage.transaction(async (transaction) => {
          const migration = await backfillIndex(transaction, "session", revokedAt);
          if (!migration.ready) {
            await this.scheduleMigration(transaction);
            return false;
          }
          const sessions: Array<[string, Record<string, unknown>]> = [];
          let startAfter: string | undefined;
          let complete = false;
          for (let page = 0; page < MAX_INDEX_PAGES; page += 1) {
            const options: DurableObjectListOptions = {
              prefix: SESSION_ACTIVE_PREFIX, limit: INDEX_PAGE_SIZE,
            };
            if (startAfter) options.startAfter = startAfter;
            const active = await transaction.list<AuthRecord>(options);
            for (const [activeKey, indexed] of active) {
              if (!isActiveRecord(indexed, revokedAt)) {
                await transaction.delete(activeKey);
                continue;
              }
              const digest = activeKey.slice(SESSION_ACTIVE_PREFIX.length);
              const recordKey = `${SESSION_PREFIX}${digest}`;
              const record = await transaction.get<Record<string, unknown>>(recordKey);
              if (record && record["revokedAt"] == null) sessions.push([recordKey, record]);
            }
            if (active.size < INDEX_PAGE_SIZE) {
              complete = true;
              break;
            }
            startAfter = [...active.keys()].at(-1);
          }
          if (!complete) {
            await this.scheduleMigration(transaction);
            return false;
          }
          for (const [key, record] of sessions) {
            const digest = key.slice(SESSION_PREFIX.length);
            const previous = record as AuthRecord;
            const updated = { ...record, revokedAt } as AuthRecord;
            await transaction.put(key, updated);
            await writeExpiryIndex(transaction, "session", digest, previous, updated);
            if (isActiveRecord(updated, new Date().toISOString())) {
              await transaction.put(`${SESSION_ACTIVE_PREFIX}${digest}`, {
                expiresAt: updated.expiresAt, revokedAt,
              });
            } else {
              await transaction.delete(`${SESSION_ACTIVE_PREFIX}${digest}`);
            }
          }
          return true;
        });
        if (!applied) {
          await this.scheduleGc(Date.now() + 1_000);
          return Response.json({ error: "session index is being prepared" }, { status: 503 });
        }
        return new Response(null, { status: 204 });
      }
      case "/sessions/count-active": {
        const { now } = body as { now: string };
        const count = await this.state.storage.transaction(async (transaction) => {
          const migration = await backfillIndex(transaction, "session", now);
          if (!migration.ready) {
            await this.scheduleMigration(transaction);
            return null;
          }
          let count = 0;
          let startAfter: string | undefined;
          let complete = false;
          for (let page = 0; page < MAX_INDEX_PAGES; page += 1) {
            const options: DurableObjectListOptions = {
              prefix: SESSION_ACTIVE_PREFIX, limit: INDEX_PAGE_SIZE,
            };
            if (startAfter) options.startAfter = startAfter;
            const entries = await transaction.list<AuthRecord>(options);
            for (const [key, record] of entries) {
              if (isActiveRecord(record, now)) count += 1;
              else await transaction.delete(key);
            }
            if (entries.size < INDEX_PAGE_SIZE) {
              complete = true;
              break;
            }
            startAfter = [...entries.keys()].at(-1);
          }
          if (!complete) await this.scheduleMigration(transaction);
          return complete ? count : null;
        });
        if (count === null) {
          await this.scheduleGc(Date.now() + 1_000);
          return Response.json({ error: "session index is being prepared" }, { status: 503 });
        }
        return Response.json({ count });
      }

      case "/credentials/create": {
        const { digest, record } = body as { digest: string; record: AuthRecord };
        await this.state.storage.transaction(async (transaction) => {
          await transaction.put(`${CREDENTIAL_PREFIX}${digest}`, record);
          if (isActiveRecord(record, new Date().toISOString())) {
            await transaction.put(`${CREDENTIAL_ACTIVE_PREFIX}${digest}`, {
              expiresAt: record.expiresAt, revokedAt: record.revokedAt,
            });
          }
          await writeExpiryIndex(transaction, "credential", digest, null, record);
        });
        const at = cleanupAt(record);
        if (at !== null) await this.scheduleGc(at);
        return new Response(null, { status: 204 });
      }
      case "/credentials/get": {
        const { digest } = body as { digest: string };
        const record = await this.state.storage.get(`${CREDENTIAL_PREFIX}${digest}`);
        return Response.json({ record: record ?? null });
      }
      case "/credentials/list": {
        const items = await this.state.storage.transaction(async (transaction) => {
          const migration = await backfillIndex(transaction, "credential", new Date().toISOString());
          if (!migration.ready) {
            await this.scheduleMigration(transaction);
            return null;
          }
          const result: Array<{ digest: string; record: unknown }> = [];
          let startAfter: string | undefined;
          let complete = false;
          for (let page = 0; page < MAX_INDEX_PAGES; page += 1) {
            const options: DurableObjectListOptions = {
              prefix: CREDENTIAL_ACTIVE_PREFIX, limit: INDEX_PAGE_SIZE,
            };
            if (startAfter) options.startAfter = startAfter;
            const entries = await transaction.list<AuthRecord>(options);
            for (const [activeKey, active] of entries) {
              const digest = activeKey.slice(CREDENTIAL_ACTIVE_PREFIX.length);
              const recordKey = `${CREDENTIAL_PREFIX}${digest}`;
              const record = await transaction.get<AuthRecord>(recordKey);
              if (!record || !isActiveRecord(active, new Date().toISOString())) {
                await transaction.delete(activeKey);
                continue;
              }
              result.push({ digest, record });
            }
            if (entries.size < INDEX_PAGE_SIZE) {
              complete = true;
              break;
            }
            startAfter = [...entries.keys()].at(-1);
          }
          if (!complete) {
            await this.scheduleMigration(transaction);
            return null;
          }
          return result;
        });
        if (items === null) {
          await this.scheduleGc(Date.now() + 1_000);
          return Response.json({ error: "credential index is being prepared" }, { status: 503 });
        }
        return Response.json({ items });
      }
      case "/credentials/touch-last-used": {
        const { digest, lastUsedAt } = body as { digest: string; lastUsedAt: string };
        const key = `${CREDENTIAL_PREFIX}${digest}`;
        const existing = await this.state.storage.get<Record<string, unknown>>(key);
        if (existing) {
          await this.state.storage.put(key, { ...existing, lastUsedAt });
        }
        return new Response(null, { status: 204 });
      }
      case "/credentials/revoke": {
        const { digest, revokedAt } = body as { digest: string; revokedAt: string };
        await this.state.storage.transaction(async (transaction) => {
          const key = `${CREDENTIAL_PREFIX}${digest}`;
          const existing = await transaction.get<Record<string, unknown>>(key);
          if (!existing) return;
          const previous = existing as AuthRecord;
          const updated = { ...existing, revokedAt } as AuthRecord;
          await transaction.put(key, updated);
          await writeExpiryIndex(transaction, "credential", digest, previous, updated);
          const activeKey = `${CREDENTIAL_ACTIVE_PREFIX}${digest}`;
          if (isActiveRecord(updated, new Date().toISOString())) {
            await transaction.put(activeKey, { expiresAt: updated.expiresAt, revokedAt });
          } else {
            await transaction.delete(activeKey);
          }
        });
        const record = await this.state.storage.get<AuthRecord>(`${CREDENTIAL_PREFIX}${digest}`);
        const at = record ? cleanupAt(record) : null;
        if (at !== null) await this.scheduleGc(at);
        return new Response(null, { status: 204 });
      }
      case "/credentials/revoke-all": {
        const { revokedAt } = body as { revokedAt: string };
        const applied = await this.state.storage.transaction(async (transaction) => {
          const migration = await backfillIndex(transaction, "credential", revokedAt);
          if (!migration.ready) {
            await this.scheduleMigration(transaction);
            return false;
          }
          const credentials: Array<[string, Record<string, unknown>]> = [];
          let startAfter: string | undefined;
          let complete = false;
          for (let page = 0; page < MAX_INDEX_PAGES; page += 1) {
            const options: DurableObjectListOptions = {
              prefix: CREDENTIAL_ACTIVE_PREFIX, limit: INDEX_PAGE_SIZE,
            };
            if (startAfter) options.startAfter = startAfter;
            const active = await transaction.list<AuthRecord>(options);
            for (const [activeKey, indexed] of active) {
              if (!isActiveRecord(indexed, revokedAt)) {
                await transaction.delete(activeKey);
                continue;
              }
              const digest = activeKey.slice(CREDENTIAL_ACTIVE_PREFIX.length);
              const recordKey = `${CREDENTIAL_PREFIX}${digest}`;
              const record = await transaction.get<Record<string, unknown>>(recordKey);
              if (record && record["revokedAt"] == null) credentials.push([recordKey, record]);
            }
            if (active.size < INDEX_PAGE_SIZE) {
              complete = true;
              break;
            }
            startAfter = [...active.keys()].at(-1);
          }
          if (!complete) {
            await this.scheduleMigration(transaction);
            return false;
          }
          for (const [key, record] of credentials) {
            const digest = key.slice(CREDENTIAL_PREFIX.length);
            const previous = record as AuthRecord;
            const updated = { ...record, revokedAt } as AuthRecord;
            await transaction.put(key, updated);
            await writeExpiryIndex(transaction, "credential", digest, previous, updated);
            if (isActiveRecord(updated, new Date().toISOString())) {
              await transaction.put(`${CREDENTIAL_ACTIVE_PREFIX}${digest}`, {
                expiresAt: updated.expiresAt, revokedAt,
              });
            } else {
              await transaction.delete(`${CREDENTIAL_ACTIVE_PREFIX}${digest}`);
            }
          }
          return true;
        });
        if (!applied) {
          await this.scheduleGc(Date.now() + 1_000);
          return Response.json({ error: "credential index is being prepared" }, { status: 503 });
        }
        return new Response(null, { status: 204 });
      }

      case "/github-token/store": {
        const { encrypted, accessTokenExpiresAt, refreshTokenExpiresAt } = body as {
          encrypted: unknown;
          accessTokenExpiresAt: string | null;
          refreshTokenExpiresAt: string | null;
        };
        const current = await this.state.storage.get<Record<string, unknown>>(GITHUB_TOKEN_KEY);
        await this.state.storage.put(GITHUB_TOKEN_KEY, {
          encrypted,
          accessTokenExpiresAt,
          refreshTokenExpiresAt,
          revision: Number(current?.["revision"] ?? 0) + 1,
          refreshLockedUntil: null,
          refreshLockId: null,
        });
        return new Response(null, { status: 204 });
      }
      case "/github-token/get": {
        const state = await this.state.storage.get(GITHUB_TOKEN_KEY);
        return Response.json({ state: state ?? null });
      }
      case "/github-token/lock": {
        const { lockId, lockUntil, now, expectedRevision } = body as {
          lockId: string;
          lockUntil: string;
          now: string;
          expectedRevision: number;
        };
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          return Response.json({ error: "invalid revision" }, { status: 400 });
        }
        const acquired = await this.state.storage.transaction(async (transaction) => {
          const current = await transaction.get<Record<string, unknown>>(GITHUB_TOKEN_KEY);
          if (!current || current["revision"] !== expectedRevision) return false;
          const expires = current["refreshLockedUntil"];
          if (typeof expires === "string" && new Date(expires).getTime() > new Date(now).getTime()) return false;
          await transaction.put(GITHUB_TOKEN_KEY, { ...current, refreshLockId: lockId, refreshLockedUntil: lockUntil });
          return true;
        });
        return Response.json({ acquired });
      }
      case "/github-token/rotate": {
        const { lockId, expectedRevision, encrypted, accessTokenExpiresAt, refreshTokenExpiresAt } = body as {
          lockId: string;
          expectedRevision: number;
          encrypted: unknown;
          accessTokenExpiresAt: string | null;
          refreshTokenExpiresAt: string | null;
        };
        const stored = await this.state.storage.transaction(async (transaction) => {
          const current = await transaction.get<Record<string, unknown>>(GITHUB_TOKEN_KEY);
          if (!current || current["refreshLockId"] !== lockId || current["revision"] !== expectedRevision) return false;
          await transaction.put(GITHUB_TOKEN_KEY, {
            encrypted,
            accessTokenExpiresAt,
            refreshTokenExpiresAt,
            revision: expectedRevision + 1,
            refreshLockedUntil: null,
            refreshLockId: null,
          });
          return true;
        });
        return Response.json({ stored });
      }
      case "/github-token/unlock": {
        const { lockId } = body as { lockId: string };
        await this.state.storage.transaction(async (transaction) => {
          const current = await transaction.get<Record<string, unknown>>(GITHUB_TOKEN_KEY);
          if (current?.["refreshLockId"] === lockId) {
            await transaction.put(GITHUB_TOKEN_KEY, { ...current, refreshLockId: null, refreshLockedUntil: null });
          }
        });
        return new Response(null, { status: 204 });
      }

      default:
        return new Response("not found", { status: 404 });
    }
  }
}
