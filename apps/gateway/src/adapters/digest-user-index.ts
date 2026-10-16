import type { UserId } from "@praetorium/auth";

/** KV is only a routing hint; authorization records remain authoritative in their Durable Object. */
export interface DigestUserIndex {
  set(digest: string, userId: UserId): Promise<void>;
  get(digest: string): Promise<UserId | null>;
}

function parseUserId(value: string | null): UserId | null {
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) return null;
  return value as UserId;
}

export function createKvDigestUserIndex(kv: KVNamespace, namespace: string): DigestUserIndex {
  const prefix = `praetorium:digest-user:${namespace}:`;
  return {
    set(digest, userId) {
      return kv.put(`${prefix}${digest}`, userId);
    },
    get(digest) {
      return kv.get(`${prefix}${digest}`).then(parseUserId);
    },
  };
}
