import type { D1Database } from "@praetorium/persistence/d1";

export interface OperatorAuditQuery { readonly cursor: string | null; readonly query: string }
export interface OperatorAuditPage {
  readonly events: readonly { action: string; outcome: string; actorId: string | null; occurredAt: number; jobId: string | null; failureCode: string | null; leaseEpoch: number | null }[];
  readonly nextCursor: string | null;
}
interface AuditRow { event_id: string; action: string; outcome: string; actor_id: string | null; occurred_at: number; request_id: string | null; metadata_json: string }

export function parseAuditCursor(cursor: string | null): { time: number; id: string } | null {
  if (cursor === null) return null;
  const match = /^(0|[1-9][0-9]{0,15}):([A-Za-z0-9_.:-]{1,255})$/u.exec(cursor);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new TypeError("Invalid audit cursor");
  return { time: Number(match[1]), id: match[2]! };
}
/** Read existing release AND source events, with deterministic keyset pagination. */
export async function readOperatorAudit(db: D1Database, input: OperatorAuditQuery): Promise<OperatorAuditPage> {
  const cursor = parseAuditCursor(input.cursor);
  if (input.query.length > 100 || [...input.query].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new TypeError("Invalid audit search");
  const rows = await db.prepare(
    `SELECT event_id, actor_id, action, outcome, occurred_at, request_id, metadata_json FROM audit_events
     WHERE (action LIKE 'release.%' OR action LIKE 'source-release-build.%')
       AND (? IS NULL OR occurred_at < ? OR (occurred_at = ? AND event_id < ?))
       AND (? = '' OR instr(lower(action || ' ' || outcome || ' ' || coalesce(actor_id,'') || ' ' || coalesce(request_id,'') || ' ' || metadata_json), lower(?)) > 0)
     ORDER BY occurred_at DESC, event_id DESC LIMIT 26`,
  ).bind(cursor?.time ?? null, cursor?.time ?? null, cursor?.time ?? null, cursor?.id ?? null,
    input.query, input.query).all<AuditRow>();
  const page = rows.results.slice(0, 25);
  const last = page.at(-1);
  return {
    events: page.map(row => {
      let meta: Record<string, unknown> = {};
      if (row.action.startsWith("source-release-build.")) {
        try {
          const raw: unknown = JSON.parse(row.metadata_json);
          if (raw && typeof raw === "object" && !Array.isArray(raw)) meta = raw as Record<string, unknown>;
        } catch { /* Invalid historic metadata remains private. */ }
      }
      const candidate = row.request_id ?? meta.jobId;
      const jobId = typeof candidate === "string" && /^sr_[0-9a-f-]{36}$/u.test(candidate) ? candidate : null;
      const failure = meta.failureCode;
      return {
        actorId: row.actor_id, action: row.action, outcome: row.outcome, occurredAt: row.occurred_at,
        jobId, failureCode: typeof failure === "string" && /^[A-Z][A-Z0-9_]{0,89}$/u.test(failure) ? failure : null,
        leaseEpoch: typeof meta.leaseEpoch === "number" && Number.isSafeInteger(meta.leaseEpoch) && meta.leaseEpoch > 0 ? meta.leaseEpoch : null,
      };
    }),
    nextCursor: rows.results.length > 25 && last ? `${last.occurred_at}:${last.event_id}` : null,
  };
}
