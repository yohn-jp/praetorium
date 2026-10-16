import { describe, expect, it } from "vitest";
import { shardNameFor } from "../src/adapters/durable-objects/shard.js";

describe("shardNameFor", () => {
  it("is deterministic for the same key", () => {
    expect(shardNameFor("some-state-value")).toBe(shardNameFor("some-state-value"));
  });

  it("spreads different keys across more than one shard", () => {
    const shards = new Set(Array.from({ length: 200 }, (_, index) => shardNameFor(`key-${index}`)));
    expect(shards.size).toBeGreaterThan(1);
  });
});
