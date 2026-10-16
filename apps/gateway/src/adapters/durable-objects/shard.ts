const SHARD_COUNT = 32;

function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministically routes a key with no known owner yet (OAuth login
 * state, a handoff code's digest) to one of a fixed pool of Durable Object
 * shards, so no single object becomes a gateway-wide bottleneck.
 */
export function shardNameFor(key: string): string {
  return `shard-${fnv1aHash(key) % SHARD_COUNT}`;
}
