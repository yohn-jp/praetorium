import { BuildInputSchema } from "@praetorium/contracts";
import { ConfigurationSelectionSchema } from "@praetorium/application/configurations";
import type { StableFollower, StableFollowerRepository } from "@praetorium/application/rollouts";
import type { CursorPage } from "@praetorium/application/releases";
import type { T11D1Database } from "./t11-release-rollouts.js";

interface FollowerRow {
  readonly repository_id: number;
  readonly instance_id: string;
  readonly binding_epoch: number;
  readonly authorization_revision: number;
  readonly generation: number;
  readonly runtime_epoch: number;
  readonly desired_state: "running" | "stopped";
  readonly policy: "stable" | "pinned";
  readonly desired_revision_id: string;
  readonly desired_artifact_digest: string | null;
  readonly current_artifact_digest: string | null;
  readonly cluster_id: string | null;
  readonly selection_json: string;
  readonly build_input_json: string;
}

/** Reads actual repository configuration and runtime assignment from D1. */
export class D1StableFollowerRepository implements StableFollowerRepository {
  constructor(
    private readonly db: T11D1Database,
    private readonly defaultClusterId: string,
  ) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(defaultClusterId)) {
      throw new TypeError("a valid default runtime cluster ID is required");
    }
  }

  async listInstances(cursor: string | null, limit: number): Promise<CursorPage<StableFollower>> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.db
      .prepare(
        `${FOLLOWER_QUERY}
         WHERE b.suspended = 0 AND i.desired_revision_id IS NOT NULL
           AND (? IS NULL OR i.instance_id > ?)
         ORDER BY i.instance_id
         LIMIT ?`,
      )
      .bind(cursor, cursor, boundedLimit + 1)
      .all<FollowerRow>();
    const rows = [...(result.results ?? [])];
    const hasMore = rows.length > boundedLimit;
    const pageRows = hasMore ? rows.slice(0, boundedLimit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => this.toFollower(row)),
      nextCursor: hasMore && last ? last.instance_id : null,
    };
  }

  async findCurrent(instanceId: string): Promise<StableFollower | null> {
    if (!instanceId || instanceId.length > 128) throw new TypeError("instance ID is invalid");
    const row = await this.db
      .prepare(
        `${FOLLOWER_QUERY}
         WHERE i.instance_id = ? AND b.suspended = 0 AND i.desired_revision_id IS NOT NULL
         LIMIT 1`,
      )
      .bind(instanceId)
      .first<FollowerRow>();
    return row ? this.toFollower(row) : null;
  }

  private toFollower(row: FollowerRow): StableFollower {
    const selection = ConfigurationSelectionSchema.parse(JSON.parse(row.selection_json));
    const buildInput = BuildInputSchema.parse(JSON.parse(row.build_input_json));
    if (
      selection.policy !== row.policy ||
      JSON.stringify([...selection.requestedModules].sort()) !==
        JSON.stringify([...buildInput.requestedModules].sort())
    ) {
      throw new TypeError("stored follower configuration does not match its selected build input");
    }
    return {
      instanceId: row.instance_id,
      repositoryId: row.repository_id,
      bindingEpoch: row.binding_epoch,
      authorizationRevision: row.authorization_revision,
      clusterId: row.cluster_id ?? this.defaultClusterId,
      generation: row.generation,
      runtimeEpoch: row.runtime_epoch,
      desiredState: row.desired_state,
      policy: row.policy,
      desiredReleaseId: selection.releaseId,
      desiredArtifactDigest: row.desired_artifact_digest,
      currentArtifactDigest: row.current_artifact_digest,
      configurationRevision: row.desired_revision_id,
      selectedModuleIds: [...selection.requestedModules].sort(),
      resourceProfileId: selection.resourceProfileId,
      platform: buildInput.platform,
    };
  }
}

const FOLLOWER_QUERY = `
  SELECT b.repository_id, b.instance_id, b.binding_epoch, b.authorization_revision,
         i.generation, i.runtime_epoch, i.desired_state, i.policy,
         i.desired_revision_id, i.desired_artifact_digest, i.current_artifact_digest,
         COALESCE(current_reservation.cluster_id, latest_reservation.cluster_id) AS cluster_id,
         d.selection_json, builds.build_input_json
    FROM repository_bindings b
    JOIN logical_instances i
      ON i.instance_id = b.instance_id AND i.repository_id = b.repository_id
    JOIN deployment_revisions d
      ON d.revision_id = i.desired_revision_id
     AND d.instance_id = i.instance_id AND d.repository_id = i.repository_id
    JOIN builds ON builds.build_id = d.build_id AND builds.build_key = d.build_key
    LEFT JOIN runtime_reservations current_reservation
      ON current_reservation.reservation_id = i.reservation_id
    LEFT JOIN runtime_reservations latest_reservation
      ON latest_reservation.instance_id = i.instance_id
     AND latest_reservation.runtime_epoch = (
       SELECT MAX(previous.runtime_epoch)
         FROM runtime_reservations previous
        WHERE previous.instance_id = i.instance_id
     )`;
