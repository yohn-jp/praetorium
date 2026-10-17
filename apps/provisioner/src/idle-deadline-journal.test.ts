import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdleDeadlineJournal } from "./idle-deadline-journal.js";

const record = {
  instanceId: "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  repositoryId: 123456,
  generation: 7,
  runtimeEpoch: 9,
  clusterId: "clu_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  lastMeaningfulActivityAt: 1_800_000_000_000,
  deadlineAt: 1_800_000_900_000,
  updatedAt: 1_800_000_000_000,
} as const;

describe("IdleDeadlineJournal", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("atomically persists bounded scheduler hints with private file mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "praetorium-idle-journal-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const journal = new IdleDeadlineJournal(path);
    await journal.load();

    expect(await journal.put(record)).toBe(true);
    const restored = new IdleDeadlineJournal(path);
    await restored.load();

    expect(restored.get(record)).toEqual(record);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const content = await readFile(path, "utf8");
    expect(content).not.toMatch(/token|credential|secret|jwt/iu);
  });

  it("does not restore a scheduler hint under a different epoch or generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "praetorium-idle-journal-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const journal = new IdleDeadlineJournal(path);
    await journal.load();
    await journal.put(record);
    const restored = new IdleDeadlineJournal(path);
    await restored.load();

    expect(restored.get({ ...record, runtimeEpoch: record.runtimeEpoch + 1 })).toBeUndefined();
    expect(restored.get({ ...record, generation: record.generation + 1 })).toBeUndefined();
  });

  it("prunes and removes scheduler hints without touching runtime resources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "praetorium-idle-journal-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const journal = new IdleDeadlineJournal(path);
    await journal.load();
    const historical = { ...record, instanceId: "ins_01ARZ3NDEKTSV4RRFFQ69G5FAA" };
    await journal.put(record);
    await journal.put(historical);

    expect(await journal.prune(new Map([[record.instanceId, record]]))).toBe(true);
    expect(journal.get(record)).toEqual(record);
    expect(journal.get(historical)).toBeUndefined();
    expect(await journal.remove(record)).toBe(true);
    expect(journal.get(record)).toBeUndefined();

    const restored = new IdleDeadlineJournal(path);
    await restored.load();
    expect(restored.get(record)).toBeUndefined();
  });

  it("removes a scheduler hint by instance after a current-candidate lookup returns null", async () => {
    const directory = await mkdtemp(join(tmpdir(), "praetorium-idle-journal-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const journal = new IdleDeadlineJournal(path);
    await journal.load();
    await journal.put(record);

    expect(await journal.removeByInstance(record.instanceId)).toBe(true);
    expect(journal.get(record)).toBeUndefined();
    const restored = new IdleDeadlineJournal(path);
    await restored.load();
    expect(restored.get(record)).toBeUndefined();
  });

  it("fails closed on a malformed durable file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "praetorium-idle-journal-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    await writeFile(path, "{}");
    const journal = new IdleDeadlineJournal(path);

    await expect(journal.load()).rejects.toThrow("idle_deadline_journal_unavailable");
    expect(journal.persistent).toBe(false);
  });

  it("rejects an oversized journal before allocating based on its file size", async () => {
    const directory = await mkdtemp(join(tmpdir(), "praetorium-idle-journal-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    await writeFile(path, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    const journal = new IdleDeadlineJournal(path);

    await expect(journal.load()).rejects.toThrow("idle_deadline_journal_unavailable");
    expect(journal.persistent).toBe(false);
  });

  it("remains non-persistent when no durable path is configured", async () => {
    const journal = new IdleDeadlineJournal(undefined);
    await journal.load();

    expect(journal.persistent).toBe(false);
    expect(await journal.put(record)).toBe(false);
  });
});
