const SESSION_PREFIX = "session:";
const CREDENTIAL_PREFIX = "credential:";
const SESSION_ACTIVE_PREFIX = "session-active:";
const CREDENTIAL_ACTIVE_PREFIX = "credential-active:";
const CREDENTIAL_ID_PREFIX = "credential-id:";
const CREDENTIAL_RECORD_EPOCH_PREFIX = "credential-record-epoch:";
const CREDENTIAL_GENERATION_INDEX_PREFIX = "credential-generation-index:";
const CREDENTIAL_EPOCH_KEY = "credential-generation:v1:current";
const CREDENTIAL_REVOKED_THROUGH_KEY = "credential-generation:v1:revoked-through";
const CREDENTIAL_REVOKE_CLEANUP_EPOCH_KEY = "credential-generation:v1:cleanup-epoch";
const CREDENTIAL_REVOKE_CLEANUP_CURSOR_KEY = "credential-generation:v1:cleanup-cursor";
const CREDENTIAL_REVOKE_FENCE_PREFIX = "credential-revoke-at:";
const CREDENTIAL_NEXT_REVOKE_FENCE_KEY = "credential-fence-next-at:v1";
const AUTH_EXPIRY_PREFIX = "auth-expiry:";
const SESSION_INDEX_READY_KEY = "session-index:v1:ready";
const SESSION_INDEX_CURSOR_KEY = "session-index:v1:cursor";
const CREDENTIAL_INDEX_READY_KEY = "credential-index:v2:ready";
const CREDENTIAL_INDEX_CURSOR_KEY = "credential-index:v2:cursor";
const GITHUB_TOKEN_KEY = "github-user-token";
const INDEX_PAGE_SIZE = 100;
const MAX_INDEX_PAGES = 10;

type AuthRecord = { readonly expiresAt: string; readonly revokedAt: string | null };
type IndexResult = { readonly ready: boolean };
type CredentialFence = { readonly targetEpoch: number; readonly revokedAt: string };

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

function generationSuffix(epoch: number): string {
  return String(epoch).padStart(16, "0");
}

function credentialIdKey(id: string): string {
  return `${CREDENTIAL_ID_PREFIX}${encodeURIComponent(id)}`;
}

function credentialGenerationIndexKey(epoch: number, digest: string): string {
  return `${CREDENTIAL_GENERATION_INDEX_PREFIX}${generationSuffix(epoch)}:${digest}`;
}

function credentialFenceKey(at: number, targetEpoch: number): string {
  return `${CREDENTIAL_REVOKE_FENCE_PREFIX}${String(Math.trunc(at)).padStart(16, "0")}:${generationSuffix(targetEpoch)}`;
}

function encodeCursor(key: string): string {
  return btoa(key).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(cursor: string): string | null {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const key = atob(padded);
    return key.startsWith(CREDENTIAL_ACTIVE_PREFIX) ? key : null;
  } catch {
    return null;
  }
}

async function credentialEpoch(
  transaction: DurableObjectTransaction,
  digest: string,
): Promise<number> {
  const epoch = await transaction.get<number>(`${CREDENTIAL_RECORD_EPOCH_PREFIX}${digest}`);
  if (epoch === undefined) return 0;
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : Number.MAX_SAFE_INTEGER;
}

async function revokedThrough(transaction: DurableObjectTransaction): Promise<number> {
  const value = await transaction.get<number>(CREDENTIAL_REVOKED_THROUGH_KEY);
  if (value === undefined) return 0;
  return Number.isSafeInteger(value) && value >= 0 ? value : Number.MAX_SAFE_INTEGER;
}

async function applyDueCredentialFences(
  transaction: DurableObjectTransaction,
  nowMs: number,
): Promise<boolean> {
  const nextAt = await transaction.get<number>(CREDENTIAL_NEXT_REVOKE_FENCE_KEY);
  if (nextAt === undefined) return true;
  if (!Number.isSafeInteger(nextAt)) return false;
  if (nextAt > nowMs) return true;
  const due = await transaction.list<CredentialFence>({
    prefix: CREDENTIAL_REVOKE_FENCE_PREFIX,
    limit: INDEX_PAGE_SIZE,
  });
  let cutoff = await revokedThrough(transaction);
  let applied = 0;
  let invalidFence = false;
  for (const [key, fence] of due) {
    const at = Number(key.slice(CREDENTIAL_REVOKE_FENCE_PREFIX.length).split(":", 1)[0]);
    if (!Number.isSafeInteger(at) || at > nowMs) break;
    if (!Number.isSafeInteger(fence?.targetEpoch) || fence.targetEpoch < 0) {
      invalidFence = true;
      break;
    }
    cutoff = Math.max(cutoff, fence.targetEpoch);
    await transaction.delete(key);
    applied += 1;
  }
  if (applied > 0) await transaction.put(CREDENTIAL_REVOKED_THROUGH_KEY, cutoff);
  const first = await transaction.list<CredentialFence>({
    prefix: CREDENTIAL_REVOKE_FENCE_PREFIX,
    limit: 1,
  });
  const firstKey = first.keys().next().value as string | undefined;
  if (!firstKey) {
    await transaction.delete(CREDENTIAL_NEXT_REVOKE_FENCE_KEY);
    return true;
  }
  const firstAt = Number(firstKey.slice(CREDENTIAL_REVOKE_FENCE_PREFIX.length).split(":", 1)[0]);
  if (Number.isSafeInteger(firstAt)) await transaction.put(CREDENTIAL_NEXT_REVOKE_FENCE_KEY, firstAt);
  return !invalidFence && Number.isSafeInteger(firstAt) && firstAt > nowMs;
}

async function earliestCredentialFenceAt(
  transaction: DurableObjectTransaction,
): Promise<number | null> {
  const at = await transaction.get<number>(CREDENTIAL_NEXT_REVOKE_FENCE_KEY);
  if (at === undefined) return null;
  return Number.isSafeInteger(at) ? at : 0;
}

async function effectiveCleanupAt(
  transaction: DurableObjectTransaction,
  kind: "session" | "credential",
  record: AuthRecord,
): Promise<number | null> {
  const at = cleanupAt(record);
  if (at === null || kind === "session") return at;
  const pendingFenceAt = await earliestCredentialFenceAt(transaction);
  return pendingFenceAt === null ? at : Math.max(at, pendingFenceAt);
}

async function writeExpiryIndex(
  transaction: DurableObjectTransaction,
  kind: "session" | "credential",
  digest: string,
  previous: AuthRecord | null,
  next: AuthRecord,
): Promise<void> {
  const previousAt = previous ? cleanupAt(previous) : null;
  const previousDeferredAt = previous ? await effectiveCleanupAt(transaction, kind, previous) : null;
  const nextAt = await effectiveCleanupAt(transaction, kind, next);
  if (previousAt !== null) await transaction.delete(expiryKey(kind, digest, previousAt));
  if (previousDeferredAt !== null && previousDeferredAt !== previousAt) {
    await transaction.delete(expiryKey(kind, digest, previousDeferredAt));
  }
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
  const nowMs = Date.parse(now);
  const generationCutoff = session ? 0 : await revokedThrough(transaction);
  for (const [key, unknownRecord] of rows) {
    const digest = key.slice(recordPrefix.length);
    const record = unknownRecord as AuthRecord;
    const expiresAt = timestamp(record.expiresAt);
    if (expiresAt === null || !(record.revokedAt === null || timestamp(record.revokedAt) !== null)) {
      continue;
    }
    let epoch = 0;
    if (!session) {
      epoch = await credentialEpoch(transaction, digest);
      await transaction.put(credentialGenerationIndexKey(epoch, digest), { digest });
      await transaction.put(`${CREDENTIAL_RECORD_EPOCH_PREFIX}${digest}`, epoch);
      const id = (unknownRecord as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) {
        await transaction.put(credentialIdKey(id), digest);
      }
    }
    if (isActiveRecord(record, now) && (session || epoch >= generationCutoff)) {
      await transaction.put(`${activePrefix}${digest}`, {
        expiresAt: record.expiresAt, revokedAt: record.revokedAt,
      });
    } else {
      await transaction.delete(`${activePrefix}${digest}`);
    }
    const at = await effectiveCleanupAt(transaction, kind, record);
    if (at !== null && at > nowMs) {
      await transaction.put(expiryKey(kind, digest, at), { kind, digest });
    } else if (at !== null) {
      await transaction.delete(key);
      await transaction.delete(`${activePrefix}${digest}`);
      if (!session) {
        await transaction.delete(`${CREDENTIAL_RECORD_EPOCH_PREFIX}${digest}`);
        await transaction.delete(credentialGenerationIndexKey(epoch, digest));
        const id = (unknownRecord as { id?: unknown }).id;
        if (typeof id === "string" && await transaction.get<string>(credentialIdKey(id)) === digest) {
          await transaction.delete(credentialIdKey(id));
        }
      }
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

async function cleanRevokedCredentialIndexes(
  transaction: DurableObjectTransaction,
): Promise<boolean> {
  const cutoff = await revokedThrough(transaction);
  let epoch = await transaction.get<number>(CREDENTIAL_REVOKE_CLEANUP_EPOCH_KEY) ?? 0;
  let cursor = await transaction.get<string>(CREDENTIAL_REVOKE_CLEANUP_CURSOR_KEY);
  let removed = 0;
  let emptyGenerations = 0;
  while (epoch < cutoff && removed < INDEX_PAGE_SIZE && emptyGenerations < 10) {
    const prefix = CREDENTIAL_GENERATION_INDEX_PREFIX + generationSuffix(epoch) + ':';
    const options: DurableObjectListOptions = { prefix, limit: INDEX_PAGE_SIZE };
    if (cursor) options.startAfter = cursor;
    const entries = await transaction.list<{ digest: string }>(options);
    if (entries.size === 0) {
      epoch += 1;
      cursor = undefined;
      emptyGenerations += 1;
      await transaction.put(CREDENTIAL_REVOKE_CLEANUP_EPOCH_KEY, epoch);
      await transaction.delete(CREDENTIAL_REVOKE_CLEANUP_CURSOR_KEY);
      continue;
    }
    for (const [key, locator] of entries) {
      const digest = typeof locator?.digest === 'string'
        ? locator.digest
        : key.slice(prefix.length);
      const record = await transaction.get<Record<string, unknown>>(CREDENTIAL_PREFIX + digest);
      const id = record?.['id'];
      if (typeof id === 'string') {
        const idKey = credentialIdKey(id);
        if (await transaction.get<string>(idKey) === digest) await transaction.delete(idKey);
      }
      await transaction.delete(CREDENTIAL_ACTIVE_PREFIX + digest);
      await transaction.delete(key);
      removed += 1;
    }
    const last = [...entries.keys()].at(-1);
    if (entries.size < INDEX_PAGE_SIZE) {
      epoch += 1;
      cursor = undefined;
      await transaction.put(CREDENTIAL_REVOKE_CLEANUP_EPOCH_KEY, epoch);
      await transaction.delete(CREDENTIAL_REVOKE_CLEANUP_CURSOR_KEY);
    } else {
      cursor = last;
      if (last) await transaction.put(CREDENTIAL_REVOKE_CLEANUP_CURSOR_KEY, last);
      return false;
    }
    if (removed >= INDEX_PAGE_SIZE) return false;
  }
  return epoch >= cutoff;
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
    const preparation = await this.state.storage.transaction(async (transaction) => {
      const sessions = await backfillIndex(transaction, "session", now);
      const credentials = await backfillIndex(transaction, "credential", now);
      if (!sessions.ready || !credentials.ready) return { ready: false, fencesReady: true, cleanupReady: true };
      const fencesReady = await applyDueCredentialFences(transaction, nowMs);
      const cleanupReady = await cleanRevokedCredentialIndexes(transaction);
      return { ready: true, fencesReady, cleanupReady };
    });
    if (!preparation.ready) {
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
        const nextAt = current
          ? await effectiveCleanupAt(transaction, locator.kind, current)
          : null;
        if (nextAt !== null && nextAt > nowMs) {
          await transaction.delete(indexKey);
          await transaction.put(expiryKey(locator.kind, locator.digest, nextAt), locator);
          return;
        }
        await transaction.delete(indexKey);
        await transaction.delete(recordKey);
        await transaction.delete(`${activePrefix}${locator.digest}`);
        if (locator.kind === "credential") {
          const id = (current as unknown as { id?: unknown } | undefined)?.id;
          if (typeof id === "string") {
            const idKey = credentialIdKey(id);
            if (await transaction.get<string>(idKey) === locator.digest) {
              await transaction.delete(idKey);
            }
          }
          const epoch = await credentialEpoch(transaction, locator.digest);
          await transaction.delete(`${CREDENTIAL_RECORD_EPOCH_PREFIX}${locator.digest}`);
          await transaction.delete(credentialGenerationIndexKey(epoch, locator.digest));
        }
      });
      processed += 1;
    }

    const remaining = await this.state.storage.list({ prefix: AUTH_EXPIRY_PREFIX, limit: 1 });
    const firstKey = remaining.keys().next().value as string | undefined;
    const nextExpiryAt = firstKey
      ? Number(firstKey.slice(AUTH_EXPIRY_PREFIX.length).split(":", 1)[0])
      : null;
    const nextFenceAt = await this.state.storage.transaction((transaction) =>
      earliestCredentialFenceAt(transaction));
    if (nextExpiryAt === null && nextFenceAt === null &&
        preparation.fencesReady && preparation.cleanupReady) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const hasDueExpiry = nextExpiryAt !== null && Number.isSafeInteger(nextExpiryAt) && nextExpiryAt <= nowMs;
    const hasDueFence = nextFenceAt !== null && nextFenceAt <= nowMs;
    const pendingIndexCleanup = !preparation.cleanupReady || !preparation.fencesReady;
    if (processed === INDEX_PAGE_SIZE || hasDueExpiry || hasDueFence || pendingIndexCleanup) {
      await this.scheduleGc(nowMs + 100);
      return;
    }
    const candidates = [nextExpiryAt, nextFenceAt].filter((value): value is number =>
      value !== null && Number.isSafeInteger(value));
    await this.scheduleGc(candidates.length ? Math.min(...candidates) : nowMs + 60_000);
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
        const { digest, record } = body as {
          digest: string;
          record: AuthRecord & { readonly id?: string };
        };
        if (typeof digest !== "string" || typeof record?.id !== "string" ||
            timestamp(record.expiresAt) === null) {
          return Response.json({ error: "invalid credential" }, { status: 400 });
        }
        const recordId = record.id;
        const result = await this.state.storage.transaction(async (transaction) => {
          const now = new Date().toISOString();
          if (!(await applyDueCredentialFences(transaction, Date.parse(now)))) {
            await this.scheduleMigration(transaction);
            return { ready: false, duplicate: false, at: null };
          }
          const idKey = credentialIdKey(recordId);
          const indexedDigest = await transaction.get<string>(idKey);
          if (indexedDigest && indexedDigest !== digest) {
            return { ready: true, duplicate: true, at: null };
          }
          const epochValue = await transaction.get<number>(CREDENTIAL_EPOCH_KEY);
          const epoch = Number.isSafeInteger(epochValue) && epochValue! >= 0 ? epochValue! : 0;
          await transaction.put(CREDENTIAL_EPOCH_KEY, epoch);
          await transaction.put(CREDENTIAL_RECORD_EPOCH_PREFIX + digest, epoch);
          await transaction.put(credentialGenerationIndexKey(epoch, digest), { digest });
          await transaction.put(idKey, digest);
          await transaction.put(CREDENTIAL_PREFIX + digest, record);
          if (isActiveRecord(record, now)) {
            await transaction.put(CREDENTIAL_ACTIVE_PREFIX + digest, {
              expiresAt: record.expiresAt, revokedAt: record.revokedAt,
            });
          }
          await writeExpiryIndex(transaction, "credential", digest, null, record);
          return {
            ready: true,
            duplicate: false,
            at: await effectiveCleanupAt(transaction, "credential", record),
          };
        });
        if (!result.ready) {
          await this.scheduleGc(Date.now() + 1_000);
          return Response.json({ error: "credential revocation is being prepared" }, { status: 503 });
        }
        if (result.duplicate) return Response.json({ error: "credential ID already exists" }, { status: 409 });
        if (result.at !== null) await this.scheduleGc(result.at);
        return new Response(null, { status: 204 });
      }
      case "/credentials/get": {
        const { digest } = body as { digest: string };
        const result = await this.state.storage.transaction(async (transaction) => {
          const nowMs = Date.now();
          if (!(await applyDueCredentialFences(transaction, nowMs))) return { ready: false, record: null };
          const record = await transaction.get<Record<string, unknown>>(CREDENTIAL_PREFIX + digest);
          if (!record) return { ready: true, record: null };
          const epoch = await credentialEpoch(transaction, digest);
          if (epoch < await revokedThrough(transaction)) return { ready: true, record: null };
          return { ready: true, record };
        });
        if (!result.ready) {
          await this.scheduleGc(Date.now() + 100);
          return Response.json({ error: "credential revocation is being prepared" }, { status: 503 });
        }
        return Response.json({ record: result.record });
      }
      case "/credentials/list": {
        const requestedCursor = body["cursor"];
        const cursor = requestedCursor === undefined ? undefined :
          typeof requestedCursor === "string" ? decodeCursor(requestedCursor) : null;
        if (requestedCursor !== undefined && !cursor) {
          return Response.json({ error: "invalid credential page cursor" }, { status: 400 });
        }
        const page = await this.state.storage.transaction(async (transaction) => {
          if (!(await applyDueCredentialFences(transaction, Date.now()))) {
            await this.scheduleMigration(transaction);
            return null;
          }
          const migration = await backfillIndex(transaction, "credential", new Date().toISOString());
          if (!migration.ready) {
            await this.scheduleMigration(transaction);
            return null;
          }
          const result: Array<{ digest: string; record: unknown }> = [];
          const options: DurableObjectListOptions = {
            prefix: CREDENTIAL_ACTIVE_PREFIX, limit: INDEX_PAGE_SIZE,
          };
          if (cursor) options.startAfter = cursor;
          const entries = await transaction.list<AuthRecord>(options);
          const now = new Date().toISOString();
          const cutoff = await revokedThrough(transaction);
          for (const [activeKey, active] of entries) {
            const digest = activeKey.slice(CREDENTIAL_ACTIVE_PREFIX.length);
            const record = await transaction.get<Record<string, unknown>>(CREDENTIAL_PREFIX + digest);
            const epoch = await credentialEpoch(transaction, digest);
            if (!record || epoch < cutoff || !isActiveRecord(active, now)) {
              await transaction.delete(activeKey);
              continue;
            }
            result.push({ digest, record });
          }
          const last = [...entries.keys()].at(-1);
          const more = last && entries.size === INDEX_PAGE_SIZE
            ? await transaction.list<AuthRecord>({
              prefix: CREDENTIAL_ACTIVE_PREFIX, startAfter: last, limit: 1,
            })
            : null;
          return {
            items: result,
            ...(more?.size ? { nextCursor: encodeCursor(last!) } : {}),
          };
        });
        if (page === null) {
          await this.scheduleGc(Date.now() + 1_000);
          return Response.json({ error: "credential index is being prepared" }, { status: 503 });
        }
        return Response.json(page);
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
        const at = timestamp(revokedAt);
        if (typeof digest !== "string" || at === null) {
          return Response.json({ error: "invalid credential revocation" }, { status: 400 });
        }
        const cleanupAtAfter = await this.state.storage.transaction(async (transaction) => {
          const key = CREDENTIAL_PREFIX + digest;
          const existing = await transaction.get<Record<string, unknown>>(key);
          if (!existing) return null;
          const previous = existing as AuthRecord;
          const updated = { ...existing, revokedAt } as AuthRecord;
          await transaction.put(key, updated);
          await writeExpiryIndex(transaction, "credential", digest, previous, updated);
          const activeKey = CREDENTIAL_ACTIVE_PREFIX + digest;
          const now = new Date().toISOString();
          const epoch = await credentialEpoch(transaction, digest);
          if (epoch >= await revokedThrough(transaction) && isActiveRecord(updated, now)) {
            await transaction.put(activeKey, { expiresAt: updated.expiresAt, revokedAt });
          } else {
            await transaction.delete(activeKey);
            const id = existing["id"];
            if (typeof id === "string") await transaction.delete(credentialIdKey(id));
          }
          return effectiveCleanupAt(transaction, "credential", updated);
        });
        if (cleanupAtAfter !== null) await this.scheduleGc(cleanupAtAfter);
        return new Response(null, { status: 204 });
      }
      case "/credentials/revoke-by-id": {
        const { id, revokedAt } = body as { id: string; revokedAt: string };
        const at = timestamp(revokedAt);
        if (typeof id !== "string" || id.length === 0 || at === null) {
          return Response.json({ error: "invalid credential revocation" }, { status: 400 });
        }
        const result = await this.state.storage.transaction(async (transaction) => {
          const now = new Date().toISOString();
          const migration = await backfillIndex(transaction, "credential", now);
          if (!migration.ready) {
            await this.scheduleMigration(transaction);
            return { ready: false, revoked: false, cleanupAt: null };
          }
          if (!(await applyDueCredentialFences(transaction, Date.parse(now)))) {
            await this.scheduleMigration(transaction);
            return { ready: false, revoked: false, cleanupAt: null };
          }
          const idKey = credentialIdKey(id);
          const digest = await transaction.get<string>(idKey);
          if (!digest) return { ready: true, revoked: false, cleanupAt: null };
          const recordKey = CREDENTIAL_PREFIX + digest;
          const record = await transaction.get<Record<string, unknown>>(recordKey);
          const epoch = await credentialEpoch(transaction, digest);
          const cutoff = await revokedThrough(transaction);
          if (!record || record["id"] !== id || epoch < cutoff ||
              !isActiveRecord(record as AuthRecord, now)) {
            await transaction.delete(idKey);
            return { ready: true, revoked: false, cleanupAt: null };
          }
          const previous = record as AuthRecord;
          const updated = { ...record, revokedAt } as AuthRecord;
          await transaction.put(recordKey, updated);
          await writeExpiryIndex(transaction, "credential", digest, previous, updated);
          if (isActiveRecord(updated, now)) {
            await transaction.put(CREDENTIAL_ACTIVE_PREFIX + digest, {
              expiresAt: updated.expiresAt, revokedAt,
            });
          } else {
            await transaction.delete(CREDENTIAL_ACTIVE_PREFIX + digest);
            await transaction.delete(idKey);
          }
          return {
            ready: true,
            revoked: true,
            cleanupAt: await effectiveCleanupAt(transaction, "credential", updated),
          };
        });
        if (!result.ready) {
          await this.scheduleGc(Date.now() + 1_000);
          return Response.json({ error: "credential index is being prepared" }, { status: 503 });
        }
        if (result.cleanupAt !== null) await this.scheduleGc(result.cleanupAt);
        return Response.json({ revoked: result.revoked });
      }
      case "/credentials/revoke-all": {
        const { revokedAt } = body as { revokedAt: string };
        const at = timestamp(revokedAt);
        if (at === null) return Response.json({ error: "invalid credential revocation" }, { status: 400 });
        const result = await this.state.storage.transaction(async (transaction) => {
          const previousEpochValue = await transaction.get<number>(CREDENTIAL_EPOCH_KEY);
          const previousEpoch = Number.isSafeInteger(previousEpochValue) && previousEpochValue! >= 0
            ? previousEpochValue!
            : 0;
          const nextEpoch = previousEpoch + 1;
          await transaction.put(CREDENTIAL_EPOCH_KEY, nextEpoch);
          if (at <= Date.now()) {
            const cutoff = await revokedThrough(transaction);
            await transaction.put(CREDENTIAL_REVOKED_THROUGH_KEY, Math.max(cutoff, nextEpoch));
            return { cleanupAt: Date.now() + 1 };
          }
          await transaction.put(credentialFenceKey(at, nextEpoch), {
            targetEpoch: nextEpoch, revokedAt,
          } satisfies CredentialFence);
          const currentFenceAt = await transaction.get<number>(CREDENTIAL_NEXT_REVOKE_FENCE_KEY);
          if (!Number.isSafeInteger(currentFenceAt) || currentFenceAt! > at) {
            await transaction.put(CREDENTIAL_NEXT_REVOKE_FENCE_KEY, at);
          }
          return { cleanupAt: at };
        });
        await this.scheduleGc(result.cleanupAt);
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
