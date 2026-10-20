import { z } from "zod";
import { QuiesceRequestSchema } from "@praetorium/contracts";
import type { OperationRecord } from "@praetorium/application/instances";
import type { D1Database } from "@praetorium/persistence/d1";

export interface CredentialRetirementBinding {
  fetch(request: Request): Promise<Response>;
}

/** Called only after the fenced checkpoint transaction marks known tokens pending. */
export function createCredentialRetirementBarrier(config: {
  db: D1Database;
  gateway?: CredentialRetirementBinding;
  serviceSecret?: string;
  now?: () => number;
}) {
  const now = config.now ?? Date.now;
  return async (operation: OperationRecord): Promise<boolean> => {
    let runtimeEpoch: number;
    if (operation.phase === "old-writer-absent") {
      const proof = z
        .object({
          instanceId: z.literal(operation.instanceId),
          repositoryId: z.literal(operation.repositoryId),
          retiredRuntimeEpoch: z.number().int().nonnegative().safe().nullable(),
          remainingWriters: z.literal(0),
          source: z.literal("runtime-provider-census"),
        })
        .parse(operation.checkpoint?.writerAbsenceProof);
      if (proof.retiredRuntimeEpoch === null) return true;
      runtimeEpoch = proof.retiredRuntimeEpoch;
    } else {
      const lifecycle = operation.checkpoint?.lifecycle as Record<string, unknown> | undefined;
      const request = QuiesceRequestSchema.parse(lifecycle?.quiesceRequest);
      const operationMatches =
        request.operationId === operation.id ||
        (request.operationId === `${operation.id}:rollback` &&
          request.reason === "rollback" &&
          operation.kind !== "stop");
      if (
        request.instanceId !== operation.instanceId ||
        !operationMatches ||
        operation.phase !== "quiescing-old"
      )
        throw new Error("Credential retirement checkpoint does not match the instance");
      runtimeEpoch = request.runtimeEpoch;
    }
    const remaining = async () => {
      const row = await config.db
        .prepare(
          `SELECT COUNT(*) AS remaining FROM runtime_git_credentials
         WHERE repository_id=? AND runtime_epoch=?
           AND status='revocation_pending' AND expires_at>?`,
        )
        .bind(operation.repositoryId, runtimeEpoch, now())
        .first<{ remaining: number }>();
      if (!row || !Number.isSafeInteger(row.remaining) || row.remaining < 0)
        throw new Error("Credential retirement state unavailable");
      return row.remaining;
    };
    if ((await remaining()) === 0) return true;
    if (
      !config.gateway ||
      !config.serviceSecret ||
      !/^[\x21-\x7e]{32,4096}$/u.test(config.serviceSecret)
    )
      throw new Error("Credential retirement service unavailable");
    const controller = new AbortController();
    let rejectDeadline: (error: Error) => void = () => undefined;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
      controller.abort();
      rejectDeadline(new Error("Credential retirement deadline exceeded"));
    }, 10000);
    try {
      const response = await Promise.race([
        config.gateway.fetch(
          new Request("https://gateway.internal/internal/github/retire", {
            method: "POST",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${config.serviceSecret}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              repositoryId: operation.repositoryId,
              runtimeEpoch,
            }),
          }),
        ),
        deadline,
      ]);
      // The authoritative D1 status, not a caller's echoed success, clears this barrier.
      void response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error("Credential retirement service unavailable");
      return (await remaining()) === 0;
    } finally {
      clearTimeout(timer);
    }
  };
}
