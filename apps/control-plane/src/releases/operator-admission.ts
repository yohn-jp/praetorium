import { Hono } from "hono";
import {
  createRegistryBackedReleaseVerifier,
  ingestReleaseCandidate,
  type IngestReleaseDeps,
  type IngestReleaseResult,
  type ReleaseCandidate,
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
}

/**
 * Builds the operator-only immutable release admission route. Mount this router
 * at `/v1/operator/releases`; its caller supplies the operator authority and
 * the registry, provenance, and producer-metadata verifiers.
 */
export function createOperatorReleaseAdmissionRoutes(deps: OperatorReleaseAdmissionDependencies) {
  const app = new Hono();
  const newRequestId = deps.requestId ?? (() => crypto.randomUUID());
  const verifier = createRegistryBackedReleaseVerifier(deps);

  app.post("/", async (c) => {
    let principal: OperatorReleasePrincipal | null;
    try {
      principal = await deps.authorize(c.req.raw.headers);
    } catch {
      return c.json({ error: { code: "OPERATOR_AUTHORITY_UNAVAILABLE" } }, 503);
    }
    if (!principal || !principal.actorId || principal.actorId.length > 255) {
      return c.json({ error: { code: "OPERATOR_AUTH_REQUIRED" } }, 403);
    }

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

class RequestTooLargeError extends Error {}

async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("request body is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function validRequestId(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) ? value : null;
}
