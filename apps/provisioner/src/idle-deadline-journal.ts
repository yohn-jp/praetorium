import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 10_000;

export interface IdleDeadlineBinding {
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly clusterId: string;
}

export interface IdleDeadlineRecord extends IdleDeadlineBinding {
  /** Producer-verified Unix timestamp, used only to detect newer activity. */
  readonly lastMeaningfulActivityAt: number;
  /** Durable trigger time; destructive work still requires fresh evidence. */
  readonly deadlineAt: number;
  readonly updatedAt: number;
}

export class IdleDeadlineJournalError extends Error {
  constructor(message = "idle_deadline_journal_unavailable") {
    super(message);
    this.name = "IdleDeadlineJournalError";
  }
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validRecord(value: unknown): value is IdleDeadlineRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expected = [
    "instanceId",
    "repositoryId",
    "generation",
    "runtimeEpoch",
    "clusterId",
    "lastMeaningfulActivityAt",
    "deadlineAt",
    "updatedAt",
  ];
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key))
  ) {
    return false;
  }
  return (
    typeof record.instanceId === "string" &&
    /^ins_[0-9A-HJKMNP-TV-Z]{26}$/u.test(record.instanceId) &&
    isSafePositiveInteger(record.repositoryId) &&
    isSafePositiveInteger(record.generation) &&
    isSafePositiveInteger(record.runtimeEpoch) &&
    typeof record.clusterId === "string" &&
    /^clu_[0-9A-HJKMNP-TV-Z]{26}$/u.test(record.clusterId) &&
    Number.isSafeInteger(record.lastMeaningfulActivityAt) &&
    (record.lastMeaningfulActivityAt as number) >= 0 &&
    Number.isSafeInteger(record.deadlineAt) &&
    (record.deadlineAt as number) >= 0 &&
    Number.isSafeInteger(record.updatedAt) &&
    (record.updatedAt as number) >= 0
  );
}

function sameBinding(left: IdleDeadlineBinding, right: IdleDeadlineBinding): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.repositoryId === right.repositoryId &&
    left.generation === right.generation &&
    left.runtimeEpoch === right.runtimeEpoch &&
    left.clusterId === right.clusterId
  );
}

/** Atomic, bounded scheduler hints. Journal records never authorize a stop. */
export class IdleDeadlineJournal {
  private readonly records = new Map<string, IdleDeadlineRecord>();
  private loaded = false;

  constructor(readonly path: string | undefined) {
    if (path !== undefined && (!isAbsolute(path) || path.length > 1_024)) {
      throw new TypeError("idle deadline journal path must be an absolute path");
    }
  }

  get persistent(): boolean {
    return this.path !== undefined && this.loaded;
  }

  async load(): Promise<void> {
    if (this.path === undefined) {
      this.loaded = true;
      return;
    }
    let data: Buffer;
    try {
      data = await readFile(this.path);
    } catch (error) {
      if (isMissingFile(error)) {
        this.loaded = true;
        return;
      }
      throw new IdleDeadlineJournalError();
    }
    if (data.byteLength > MAX_JOURNAL_BYTES) throw new IdleDeadlineJournalError();
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8")) as unknown;
    } catch {
      throw new IdleDeadlineJournalError();
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).version !== JOURNAL_VERSION ||
      !Array.isArray((parsed as Record<string, unknown>).records) ||
      (parsed as { records: unknown[] }).records.length > MAX_RECORDS
    ) {
      throw new IdleDeadlineJournalError();
    }
    const records = (parsed as { records: unknown[] }).records;
    for (const record of records) {
      if (!validRecord(record) || this.records.has(record.instanceId)) {
        this.records.clear();
        throw new IdleDeadlineJournalError();
      }
      this.records.set(record.instanceId, record);
    }
    this.loaded = true;
  }

  get(binding: IdleDeadlineBinding): IdleDeadlineRecord | undefined {
    const record = this.records.get(binding.instanceId);
    return record !== undefined && sameBinding(record, binding) ? record : undefined;
  }

  async put(record: IdleDeadlineRecord): Promise<boolean> {
    if (!this.persistent || this.path === undefined || !validRecord(record)) return false;
    const next = new Map(this.records);
    next.set(record.instanceId, record);
    if (next.size > MAX_RECORDS) throw new IdleDeadlineJournalError();
    const payload = Buffer.from(
      JSON.stringify({ version: JOURNAL_VERSION, records: [...next.values()] }),
      "utf8",
    );
    if (payload.byteLength > MAX_JOURNAL_BYTES) throw new IdleDeadlineJournalError();
    await this.writeAtomic(payload);
    this.records.clear();
    for (const [instanceId, value] of next) this.records.set(instanceId, value);
    return true;
  }

  private async writeAtomic(payload: Buffer): Promise<void> {
    const path = this.path;
    if (path === undefined) throw new IdleDeadlineJournalError();
    const directory = dirname(path);
    const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      file = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await file.writeFile(payload);
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, path);
      const directoryHandle = await open(directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      await file?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw new IdleDeadlineJournalError();
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
