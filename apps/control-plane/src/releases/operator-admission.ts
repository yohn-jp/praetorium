import { parseAuditCursor, type OperatorAuditPage, type OperatorAuditQuery } from "./operator-audit.js";
import { metadataFailureReason } from "../http-failure.js";
import { Hono } from "hono";
import { z } from "zod";
import { readBoundedJson, RequestTooLargeError } from "@praetorium/contracts";
import type { ReleaseRetryCommand, ReleaseRetryResult, ReleaseRetryStatus } from "./retry-contract.js";
import {
  createRegistryBackedReleaseVerifier,
  ingestReleaseCandidate,
  type IngestReleaseDeps,
  type IngestReleaseResult,
  type ReleaseCandidate,
  type StableReleaseChannel,
  type RegistryBackedReleaseVerifierDeps,
} from "@praetorium/application/releases";

const MAX_MANIFEST_BYTES = 1_048_576;

export type OperatorReleasePrincipal = { readonly actorId: string };

export interface ReleaseAdmissionExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface OperatorReleaseAdmissionDependencies
  extends Omit<IngestReleaseDeps, "verifier">,
    RegistryBackedReleaseVerifierDeps {
  /** Uses the separately configured operator authority, never repository access. */
  readonly authorize: (headers: Headers) => Promise<OperatorReleasePrincipal | null>;
  readonly requestId?: () => string;
  /** Schedules durable release work after the candidate and audit have committed. */
  readonly afterAdmitted?: (
    candidate: ReleaseCandidate,
    context: ReleaseAdmissionExecutionContext,
  ) => void;
  readonly listAuditPage?: (query: OperatorAuditQuery) => Promise<OperatorAuditPage>;
  readonly listAudit?: () => Promise<readonly {
    action: string; outcome: string; actorId: string | null; occurredAt: number;
  }[]>;
  readonly stableChannel?: () => Promise<Pick<StableReleaseChannel, "currentReleaseId" | "revision">>;
  readonly retry?: {
    status(releaseId: string): Promise<ReleaseRetryStatus | null>;
    replay(input: Pick<ReleaseRetryCommand, "releaseId" | "idempotencyKey" | "requestHash">): Promise<ReleaseRetryResult | null>;
    execute(input: Omit<ReleaseRetryCommand, "canary">): Promise<ReleaseRetryResult>;
  };
}

const ReleaseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);
const RetryRequest = z.strictObject({
  expectedRevision: z.number().int().nonnegative().safe(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u),
});

/**
 * Builds the operator-only immutable release admission route. Mount this router
 * at `/v1/operator/releases`; its caller supplies the operator authority and
 * the registry, provenance, and producer-metadata verifiers.
 */
export function createOperatorReleaseAdmissionRoutes(deps: OperatorReleaseAdmissionDependencies) {
  const app = new Hono<{ Variables: { operatorPrincipal: OperatorReleasePrincipal } }>();
  const newRequestId = deps.requestId ?? (() => crypto.randomUUID());
  const verifier = createRegistryBackedReleaseVerifier(deps);

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    let principal: OperatorReleasePrincipal | null;
    try {
      principal = await deps.authorize(c.req.raw.headers);
    } catch {
      return c.json({ error: { code: "OPERATOR_AUTHORITY_UNAVAILABLE" } }, 503);
    }
    if (!principal || !principal.actorId || principal.actorId.length > 255) {
      return c.json({ error: { code: "OPERATOR_AUTH_REQUIRED" } }, 403);
    }
    c.set("operatorPrincipal", principal);
    await next();
  });

  /** Operator-only bounded read of the existing admission catalog and workflow. */
  app.get("/", async (c) => {
    const rawCursor = c.req.query("cursor");
    if (rawCursor && (rawCursor.length > 512 || !/^(?:[A-Za-z0-9_.~:-]|%[0-9A-Fa-f]{2})+$/u.test(rawCursor)))
      return c.json({ error: { code: "INVALID_CURSOR" } }, 400);
    try {
      const page = await deps.releases.listCandidates(rawCursor ?? null, 25);
      const items = await Promise.all(page.items.map(async (candidate) => ({
        release: {
          id: candidate.id, version: candidate.version, status: candidate.status,
          imageDigest: candidate.imageDigest, createdAt: candidate.createdAt,
        },
        workflow: deps.retry ? await deps.retry.status(candidate.id) : null,
      })));
      const stableChannel = deps.stableChannel ? await deps.stableChannel() : null;
      return c.json({ items, nextCursor: page.nextCursor, stableChannel });
    } catch {
      return c.json({ error: { code: "RELEASE_LIST_UNAVAILABLE" } }, 503);
    }
  });

  app.get("/audit", async (c) => {
    if (!deps.listAudit && !deps.listAuditPage) return c.json({ error: { code: "RELEASE_AUDIT_UNAVAILABLE" } }, 503);
    try {
      const cursor = c.req.query("cursor") ?? null;
      const query = c.req.query("q") ?? "";
      try { parseAuditCursor(cursor); } catch { return c.json({ error: { code: "INVALID_CURSOR" } }, 400); }
      if (query.length > 100 || /[\u0000-\u001f\u007f]/u.test(query))
        return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
      return deps.listAuditPage
        ? c.json(await deps.listAuditPage({ cursor, query }))
        : c.json({ events: await deps.listAudit!() });
    } catch {
      return c.json({ error: { code: "RELEASE_AUDIT_UNAVAILABLE" } }, 503);
    }
  });

  app.get("/:releaseId", async (c) => {
    if (!deps.retry) return c.json({ error: { code: "RELEASE_RETRY_UNAVAILABLE" } }, 503);
    const id = ReleaseId.safeParse(c.req.param("releaseId"));
    if (!id.success) return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
    try {
      const status = await deps.retry.status(id.data);
      return status
        ? c.json(status)
        : c.json({ error: { code: "RELEASE_NOT_FOUND" } }, 404);
    } catch {
      return c.json({ error: { code: "RELEASE_STATUS_UNAVAILABLE" } }, 503);
    }
  });

  app.post("/:releaseId/retry", async (c) => {
    if (!deps.retry) return c.json({ error: { code: "RELEASE_RETRY_UNAVAILABLE" } }, 503);
    const id = ReleaseId.safeParse(c.req.param("releaseId"));
    if (!id.success) return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
    let request: z.infer<typeof RetryRequest>;
    try {
      request = RetryRequest.parse(await readBoundedJson(c.req.raw, 1024));
    } catch (error) {
      return c.json(
        { error: { code: error instanceof RequestTooLargeError ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST" } },
        error instanceof RequestTooLargeError ? 413 : 400,
      );
    }
    let stage: "receipt" | "candidate" | "evidence" | "commit" = "receipt";
    try {
      const requestHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
        JSON.stringify({ releaseId: id.data, expectedRevision: request.expectedRevision }),
      )));
      const command = {
        ...request,
        releaseId: id.data,
        actorId: c.get("operatorPrincipal").actorId,
        requestId: validRequestId(c.req.header("X-Request-Id")) ?? newRequestId(),
        requestHash: `sha256:${Array.from(requestHash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
        now: deps.clock.nowMs(),
      };
      const replay = await deps.retry.replay(command);
      if (replay?.kind === "accepted") return c.json({ ...replay.status, duplicate: true });
      if (replay?.kind === "not_found") return c.json({ error: { code: "RELEASE_NOT_FOUND" } }, 404);
      if (replay?.kind === "conflict") {
        return c.json({ error: { code: "RELEASE_RETRY_CONFLICT", reason: replay.reason } }, 409);
      }
      stage = "candidate";
      const candidate = await deps.releases.findById(id.data);
      if (!candidate) return c.json({ error: { code: "RELEASE_NOT_FOUND" } }, 404);
      stage = "evidence";
      const verification = await verifier.verify({
        schemaVersion: 1,
        version: candidate.version,
        imageRepository: candidate.imageRepository,
        catalog: candidate.catalog,
        runtimeMetadata: candidate.runtimeMetadata,
        signatureRef: candidate.signatureRef,
        provenanceRef: candidate.provenanceRef,
      });
      if (verification.kind === "retry") {
        return c.json({ error: { code: "RELEASE_EVIDENCE_UNAVAILABLE", retryable: true } }, 503);
      }
      if (verification.kind !== "verified") {
        return c.json({ error: { code: "RELEASE_CANDIDATE_DENIED" } }, 422);
      }
      stage = "commit";
      const result = await deps.retry.execute(command);
      if (result.kind === "not_found") return c.json({ error: { code: "RELEASE_NOT_FOUND" } }, 404);
      if (result.kind === "conflict") {
        return c.json({ error: { code: "RELEASE_RETRY_CONFLICT", reason: result.reason } }, 409);
      }
      try {
        deps.afterAdmitted?.(candidate, c.executionCtx);
      } catch {
        // The retry is durable; the existing recovery scheduler owns missed hints.
      }
      return c.json({ ...result.status, duplicate: result.duplicate }, result.duplicate ? 200 : 202);
    } catch (error) {
      return c.json({ error: { code: "RELEASE_RETRY_UNAVAILABLE", stage, reason: metadataFailureReason(error) } }, 503);
    }
  });

  app.post("/", async (c) => {
    const principal = c.get("operatorPrincipal");

    let manifest: unknown;
    try {
      manifest = await readBoundedJson(c.req.raw, MAX_MANIFEST_BYTES);
    } catch (error) {
      if (error instanceof RequestTooLargeError) {
        return c.json({ error: { code: "RELEASE_MANIFEST_TOO_LARGE" } }, 413);
      }
      // Let the admission service record the malformed request without ever
      // persisting or logging its body.
      manifest = undefined;
    }

    const requestId = validRequestId(c.req.header("X-Request-Id")) ?? newRequestId();
    let result: IngestReleaseResult;
    try {
      result = await ingestReleaseCandidate(
        { releases: deps.releases, verifier, clock: deps.clock, ids: deps.ids },
        manifest,
        principal.actorId,
        requestId,
      );
    } catch {
      return c.json({ error: { code: "RELEASE_ADMISSION_UNAVAILABLE" } }, 503);
    }

    if (result.kind === "retry") {
      return c.json({ error: { code: "RELEASE_EVIDENCE_UNAVAILABLE", retryable: true } }, 503);
    }
    if (result.kind === "denied") {
      return c.json({ error: { code: "RELEASE_CANDIDATE_DENIED", reason: result.reason } }, 422);
    }
    const { candidate } = result;
    if (deps.afterAdmitted) {
      try {
        deps.afterAdmitted(candidate, c.executionCtx);
      } catch {
        // Admission is already durable; the scheduled recovery path owns retries.
      }
    }
    return c.json(
      {
        release: {
          id: candidate.id,
          version: candidate.version,
          imageDigest: candidate.imageDigest,
          status: candidate.status,
        },
        duplicate: result.duplicate,
      },
      result.duplicate ? 200 : 201,
    );
  });

  return app;
}

function validRequestId(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) ? value : null;
}
