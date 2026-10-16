import type { OperationRecord } from "../instances/types.js";
import type {
  ClaimedOperation,
  OperationCheckpointInput,
  OperationObservation,
  OperationStore,
  OperationTerminal,
  ReserveRuntimeInput,
  ReservationSnapshot,
} from "./types.js";
import { OperationFenceConflict } from "./types.js";

export type LeaseTokenFactory = () => string;

export class OperationService {
  constructor(
    private readonly store: OperationStore,
    private readonly newLeaseToken: LeaseTokenFactory,
  ) {}

  getById(operationId: string): Promise<OperationRecord | null> {
    return this.store.getOperationById(operationId);
  }

  reserveRuntime(input: ReserveRuntimeInput) {
    // Stop/cleanup operations are assigned to a cluster without consuming a new reservation.
    return this.store.reserveRuntime(input);
  }

  async releaseRuntime(input: {
    readonly reservationId: string;
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly expectedReservationRuntimeEpoch: number;
    readonly now: number;
  }): Promise<void> {
    const released = await this.store.releaseRuntimeReservation(input);
    if (!released)
      throw new OperationFenceConflict(
        "reservation release lacks a current operation lease and writer-absence proof",
      );
  }

  recordCapacitySnapshot(
    input: Parameters<OperationStore["recordCapacitySnapshot"]>[0],
  ): Promise<number | null> {
    return this.store.recordCapacitySnapshot(input);
  }

  currentReservations(clusterId: string): Promise<ReservationSnapshot> {
    return this.store.currentReservations(clusterId);
  }

  claimNext(input: {
    readonly workerId: string;
    readonly clusterId: string;
    readonly now: number;
    readonly leaseSeconds?: number;
  }): Promise<ClaimedOperation | null> {
    validateLeaseRequest(input.workerId, input.leaseSeconds ?? 30);
    return this.store.claimNextOperation({
      workerId: input.workerId,
      clusterId: input.clusterId,
      leaseToken: this.newLeaseToken(),
      now: input.now,
      leaseSeconds: input.leaseSeconds ?? 30,
    });
  }

  async heartbeat(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly sequence: number;
    readonly now: number;
    readonly leaseSeconds?: number;
  }): Promise<{ readonly operation: OperationRecord; readonly leaseExpiresAt: number }> {
    validateLeaseRequest(input.workerId, input.leaseSeconds ?? 30);
    const result = await this.store.heartbeatOperation({
      ...input,
      leaseSeconds: input.leaseSeconds ?? 30,
    });
    if (!result) throw new OperationFenceConflict();
    return result;
  }

  async checkpoint(input: OperationCheckpointInput): Promise<OperationRecord> {
    const result = await this.store.appendOperationCheckpoint(input);
    if (!result)
      throw new OperationFenceConflict("operation checkpoint sequence or lease is stale");
    return result;
  }

  async advanceRuntimeEpochForRecovery(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly expectedRuntimeEpoch: number;
    readonly checkpoint: Readonly<Record<string, unknown>>;
    readonly now: number;
  }): Promise<OperationRecord> {
    const result = await this.store.advanceRuntimeEpochForRecovery(input);
    if (!result) throw new OperationFenceConflict("runtime epoch or operation lease changed");
    return result;
  }

  async report(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly sequence: number;
    readonly observation: OperationObservation;
    readonly terminal?: OperationTerminal | null;
    readonly now: number;
  }): Promise<{
    readonly operation: OperationRecord;
    readonly applied: boolean;
    readonly duplicate: boolean;
  }> {
    const result = await this.store.reportOperation({
      ...input,
      terminal: input.terminal ?? null,
    });
    if (!result) throw new OperationFenceConflict();
    return result;
  }
}

function validateLeaseRequest(workerId: string, leaseSeconds: number): void {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(workerId)) throw new TypeError("invalid worker ID");
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) {
    throw new TypeError("lease duration must be between 5 and 300 seconds");
  }
}

export type { ClaimedOperation };
