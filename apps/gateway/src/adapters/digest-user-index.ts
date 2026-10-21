import type { UserId } from "@praetorium/auth";

/** KV is only a routing hint; authorization records remain authoritative in their Durable Object. */
export interface DigestUserIndex {
  set(digest: string, userId: UserId, expiresAt?: string): Promise<void>;
  get(digest: string): Promise<UserId | null>;
  delete(digest: string): Promise<void>;
}

function parseUserId(value: string | null): UserId | null {
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) return null;
  return value as UserId;
}

export function createKvDigestUserIndex(kv: KVNamespace, namespace: string): DigestUserIndex {
  const prefix = `praetorium:digest-user:${namespace}:`;
  return {
    set(digest, userId, expiresAt) {
      if (!expiresAt) return kv.put(`${prefix}${digest}`, userId);
      const expiresAtSeconds = Math.ceil(Date.parse(expiresAt) / 1000);
      if (!Number.isSafeInteger(expiresAtSeconds)) throw new TypeError("invalid digest index expiry");
      const expiration = Math.max(Math.ceil(Date.now() / 1000) + 60, expiresAtSeconds);
      return kv.put(`${prefix}${digest}`, userId, { expiration });
    },
    get(digest) {
      return kv.get(`${prefix}${digest}`).then(parseUserId);
    },
    delete(digest) {
      return kv.delete(`${prefix}${digest}`);
    },
  };
}
