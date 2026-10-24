import { physicalInstanceId } from "@praetorium/contracts";
import { CURRENT_RUNTIME_AUTHORITY_SQL, type D1Database } from "@praetorium/persistence/d1";

export interface RuntimeBindingMetadata {
  readonly physicalInstanceId?: string;
  readonly repositoryId: number;
  readonly installationId: number;
  readonly instanceId: string;
  /** Stable assignment identity while the producer does not expose an opaque runtime UID. */
  readonly runtimeId: string;
  readonly runtimeEpoch: number;
  /** The current reservation is the durable D1 runtime lease identifier. */
  readonly leaseId: string;
  readonly clusterId: string;
  readonly active: true;
  readonly authority: "observed-writer" | "post-absence-target";
}

export interface RuntimeBindingMetadataReader {
  getCurrent(repositoryId: number): Promise<RuntimeBindingMetadata | null>;
}

interface RuntimeBindingRow {
  authority: RuntimeBindingMetadata["authority"];
  repository_id: number;
  installation_id: number;
  instance_id: string;
  legacy_runtime_epoch: number | null;
  runtime_id: string;
  runtime_epoch: number;
  lease_id: string;
  cluster_id: string;
}

interface RuntimeBindingReaderConfig {
  readonly db: D1Database;
  readonly now?: () => number;
}

function toMetadata(row: RuntimeBindingRow): RuntimeBindingMetadata {
  return {
    repositoryId: row.repository_id,
    installationId: row.installation_id,
    instanceId: row.instance_id,
    physicalInstanceId: physicalInstanceId(
      row.instance_id,
      row.runtime_epoch,
      row.legacy_runtime_epoch,
    ),
    runtimeId: row.runtime_id,
    runtimeEpoch: row.runtime_epoch,
    leaseId: row.lease_id,
    clusterId: row.cluster_id,
    active: true,
    authority: row.authority,
  };
}

/** Reads the D1 current-authority projection and live target lease, without reconstructing history. */
export function createRuntimeBindingMetadataReader(
  config: RuntimeBindingReaderConfig,
): RuntimeBindingMetadataReader {
  const now = config.now ?? Date.now;

  return {
    async getCurrent(repositoryId) {
      if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) return null;
      const nowMs = now();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0)
        throw new TypeError("runtime binding clock is invalid");

      const row = await config.db
        .prepare(CURRENT_RUNTIME_AUTHORITY_SQL)
        .bind(repositoryId, nowMs)
        .first<RuntimeBindingRow>();
      return row ? toMetadata(row) : null;
    },
  };
}
