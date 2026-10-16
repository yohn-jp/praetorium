import {
  err,
  ok,
  type Result,
} from "../domain.js";
import { keyedDigest } from "../digest.js";
import { generateToken } from "../random.js";
import type { HandoffCodeRecord, HandoffCodeStore } from "./types.js";
import type { RepositoryPermission } from "../repository-access.js";

const HANDOFF_CODE_ENTROPY_BITS = 128;

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

export interface CreateHandoffCodeInput {
  readonly userId: HandoffCodeRecord["userId"];
  readonly gatewaySessionDigest: string;
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
  readonly hostname: string;
  readonly origin: string;
  readonly audience: "instance-access";
  readonly returnPath: string;
  readonly requestedPermissions: readonly RepositoryPermission[];
  readonly now: string;
  /** Expected to be single-digit-to-low-double-digit seconds, never minutes. */
  readonly ttlSeconds: number;
  readonly pepper: Uint8Array;
}

export interface CreatedHandoffCode {
  readonly rawCode: string;
  readonly digest: string;
  readonly record: HandoffCodeRecord;
}

export async function createHandoffCode(
  store: HandoffCodeStore,
  input: CreateHandoffCodeInput,
): Promise<CreatedHandoffCode> {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1 ||
    !Number.isSafeInteger(input.runtimeEpoch) || input.runtimeEpoch < 0 ||
    !input.requestedPermissions.includes("read") || input.ttlSeconds < 1 || input.ttlSeconds > 60) {
    throw new TypeError("handoff binding, permissions, or lifetime is invalid");
  }
  const rawCode = generateToken(HANDOFF_CODE_ENTROPY_BITS);
  const digest = await keyedDigest(input.pepper, rawCode);
  const record: HandoffCodeRecord = {
    userId: input.userId,
    gatewaySessionDigest: input.gatewaySessionDigest,
    repositoryId: input.repositoryId,
    instanceId: input.instanceId,
    runtimeEpoch: input.runtimeEpoch,
    hostname: input.hostname,
    origin: input.origin,
    audience: input.audience,
    returnPath: input.returnPath,
    requestedPermissions: [...new Set(input.requestedPermissions)],
    createdAt: input.now,
    expiresAt: addSeconds(input.now, input.ttlSeconds),
  };
  await store.save(digest, record);
  return { rawCode, digest, record };
}

export type HandoffConsumeErrorCode =
  | "NOT_FOUND"
  | "EXPIRED"
  | "HOSTNAME_MISMATCH"
  | "INSTANCE_MISMATCH"
  | "REPOSITORY_MISMATCH"
  | "RUNTIME_EPOCH_MISMATCH"
  | "ORIGIN_MISMATCH"
  | "RETURN_PATH_MISMATCH"
  | "AUDIENCE_MISMATCH"
  | "SESSION_INVALID"
  | "INSTANCE_ACCESS_DENIED"
  | "STORAGE_UNAVAILABLE";

export interface HandoffConsumeError {
  readonly code: HandoffConsumeErrorCode;
  readonly message: string;
}

export interface ConsumeHandoffCodeInput {
  readonly rawCode: string;
  readonly pepper: Uint8Array;
  /** The Host/SNI the exchange request actually arrived on — checked against the code's binding, not merely trusted. */
  readonly presentedHostname: string;
  readonly presentedRepositoryId: number;
  readonly presentedInstanceId: string;
  readonly presentedRuntimeEpoch: number;
  readonly presentedOrigin: string;
  readonly presentedReturnPath?: string;
  readonly presentedAudience: "instance-access";
  readonly now: string;
}

/**
 * Atomically consumes a handoff code. The code is removed from the store
 * before any of its bindings are checked, so a replay of an
 * already-consumed code — whether it originally succeeded or failed —
 * always fails with `NOT_FOUND`.
 */
export async function consumeHandoffCode(
  store: HandoffCodeStore,
  input: ConsumeHandoffCodeInput,
): Promise<Result<HandoffCodeRecord, HandoffConsumeError>> {
  const digest = await keyedDigest(input.pepper, input.rawCode);

  let record: HandoffCodeRecord | null;
  try {
    record = await store.consume(digest);
  } catch {
    return err({ code: "STORAGE_UNAVAILABLE", message: "handoff code store unavailable" });
  }

  if (!record) {
    return err({
      code: "NOT_FOUND",
      message: "handoff code was not found, already used, or unknown",
    });
  }
  if (new Date(record.expiresAt).getTime() <= new Date(input.now).getTime()) {
    return err({ code: "EXPIRED", message: "handoff code expired" });
  }
  if (record.hostname !== input.presentedHostname) {
    return err({
      code: "HOSTNAME_MISMATCH",
      message: "handoff code is not valid for this hostname",
    });
  }
  if (record.repositoryId !== input.presentedRepositoryId) {
    return err({
      code: "REPOSITORY_MISMATCH",
      message: "handoff code is not valid for this repository",
    });
  }
  if (record.instanceId !== input.presentedInstanceId) {
    return err({
      code: "INSTANCE_MISMATCH",
      message: "handoff code is not valid for this instance",
    });
  }
  if (record.runtimeEpoch !== input.presentedRuntimeEpoch) {
    return err({ code: "RUNTIME_EPOCH_MISMATCH", message: "handoff code is not valid for this runtime epoch" });
  }
  if (record.origin !== input.presentedOrigin) {
    return err({ code: "ORIGIN_MISMATCH", message: "handoff code is not valid for this origin" });
  }
  if (input.presentedReturnPath !== undefined && record.returnPath !== input.presentedReturnPath) {
    return err({
      code: "RETURN_PATH_MISMATCH",
      message: "handoff code is not valid for this return path",
    });
  }
  if (record.audience !== input.presentedAudience) {
    return err({
      code: "AUDIENCE_MISMATCH",
      message: "handoff code is not valid for this audience",
    });
  }

  return ok(record);
}
