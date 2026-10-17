import { issueAccessGrant, constantTimeEqual, AccessGrantId } from "@praetorium/auth";
import { newAccessGrantId } from "@praetorium/domain";
import { instanceHostname } from "@praetorium/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { GatewayContext } from "./context.js";

const MAX_REQUEST_BYTES = 8_192;
const RuntimeAuthProbeRequestSchema = z.strictObject({
  operationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u),
  actorId: z.string().regex(/^[1-9][0-9]{0,15}$/u),
  instanceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u),
  repositoryId: z.number().int().positive().safe(),
  generation: z.number().int().nonnegative().safe(),
  runtimeEpoch: z.number().int().positive().safe(),
  authorizationRevision: z.number().int().nonnegative().safe(),
});

export interface RuntimeAuthProbeGrantSet {
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly origin: string;
  readonly audience: string;
  readonly authorizationRevision: number;
  readonly validGrant: string;
  readonly wrongRepositoryGrant: string;
  readonly wrongEpochGrant: string;
  readonly permissions: readonly ("read" | "write" | "maintain" | "admin")[];
}

async function boundedJson(request: Request): Promise<unknown> {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new TypeError("invalid runtime auth probe request");
  const rawLength = request.headers.get("Content-Length");
  if (rawLength !== null && (!/^(0|[1-9][0-9]*)$/u.test(rawLength) || Number(rawLength) > MAX_REQUEST_BYTES)) {
    throw new TypeError("runtime auth probe request is too large");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("runtime auth probe request body is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new TypeError("runtime auth probe request is too large");
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
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown;
}

function response(status: number, code: string): Response {
  return Response.json({ error: { code } }, {
    status,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

function differentRepository(repositoryId: number): number {
  return repositoryId < Number.MAX_SAFE_INTEGER ? repositoryId + 1 : repositoryId - 1;
}

function differentEpoch(runtimeEpoch: number): number {
  return runtimeEpoch < Number.MAX_SAFE_INTEGER ? runtimeEpoch + 1 : runtimeEpoch - 1;
}

/**
 * Private Gateway route used only by the Control Plane service binding. It
 * rechecks the operation actor against the active repository binding and
 * current GitHub App/user access before minting brief existing-schema grants.
 * The returned grants are sent only to the trusted Provisioner probe.
 */
export function createRuntimeAuthProbeRoutes(context: GatewayContext): Hono {
  const app = new Hono();
  app.post("/internal/provisioner/runtime-auth-probe", async (c) => {
    const secret = c.req.header("X-Control-Plane-Gateway-Auth") ?? "";
    if (
      c.req.header("Cookie") !== undefined ||
      !constantTimeEqual(secret, context.config.controlPlaneSecret)
    ) return response(401, "UNAUTHORIZED");

    let input: z.infer<typeof RuntimeAuthProbeRequestSchema>;
    try {
      input = RuntimeAuthProbeRequestSchema.parse(await boundedJson(c.req.raw));
    } catch {
      return response(400, "INVALID_REQUEST");
    }

    const now = context.requestNow;
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) return response(503, "AUTHORITY_UNAVAILABLE");

    try {
      const before = await context.controlPlane.getByRepositoryId(input.repositoryId);
      if (!currentBindingMatches(before, input)) return response(403, "CURRENT_BINDING_REQUIRED");

      const access = await context.githubAccess.authorize(input.actorId, input.repositoryId, "read");
      if (
        !access.allowed ||
        access.repositoryId !== input.repositoryId ||
        access.installationId !== before.binding.installationId ||
        !access.permissions.includes("read") ||
        access.expiresAt <= nowMs
      ) return response(403, "CURRENT_GITHUB_ACCESS_REQUIRED");

      // Re-read authority after GitHub calls so a binding, generation, epoch, or
      // authorization revision change cannot race issuance of a fresh probe.
      const after = await context.controlPlane.getByRepositoryId(input.repositoryId);
      if (!sameCurrentBinding(before, after) || !currentBindingMatches(after, input)) {
        return response(409, "CURRENT_BINDING_CHANGED");
      }

      const hostname = instanceHostname(input.instanceId, context.config.instanceHostnameSuffix);
      const origin = `https://${hostname}`;
      const ttlSeconds = Math.min(
        60,
        context.config.accessGrantTtlSeconds,
        Math.floor((access.expiresAt - nowMs) / 1_000),
      );
      if (ttlSeconds < 1) return response(403, "CURRENT_GITHUB_ACCESS_REQUIRED");
      const common = {
        issuer: context.config.origin,
        audience: origin,
        subjectUserId: input.actorId,
        audienceInstanceId: input.instanceId,
        runtimeEpoch: input.runtimeEpoch,
        // Repeated health checks only prove access to the assigned runtime.
        // They must never turn the operation actor into an authoring principal.
        permissions: ["read"],
        // Runtime probes do not reuse a browser session. The actual GitHub user
        // and permissions above are freshly revalidated, while this versioned
        // claim remains the canonical initial session revision.
        sessionRevision: 0,
        authorizationRevision: after.binding.authorizationRevision,
        now,
        ttlSeconds,
      } as const;
      const signingKey = await context.getSigningKey();
      const [valid, wrongRepository, wrongEpoch] = await Promise.all([
        issueAccessGrant(signingKey, {
          ...common,
          id: AccessGrantId.parse(newAccessGrantId(nowMs, crypto.getRandomValues(new Uint8Array(10)))),
          repositoryId: input.repositoryId,
        }),
        issueAccessGrant(signingKey, {
          ...common,
          id: AccessGrantId.parse(newAccessGrantId(nowMs, crypto.getRandomValues(new Uint8Array(10)))),
          repositoryId: differentRepository(input.repositoryId),
        }),
        issueAccessGrant(signingKey, {
          ...common,
          id: AccessGrantId.parse(newAccessGrantId(nowMs, crypto.getRandomValues(new Uint8Array(10)))),
          repositoryId: input.repositoryId,
          runtimeEpoch: differentEpoch(input.runtimeEpoch),
        }),
      ]);
      const result: RuntimeAuthProbeGrantSet = {
        issuer: context.config.origin,
        jwksUrl: `${context.config.origin}/.well-known/jwks.json`,
        origin,
        audience: origin,
        authorizationRevision: after.binding.authorizationRevision,
        validGrant: valid.token,
        wrongRepositoryGrant: wrongRepository.token,
        wrongEpochGrant: wrongEpoch.token,
        permissions: ["read"],
      };
      return Response.json(result, {
        headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
      });
    } catch {
      return response(503, "AUTHORITY_UNAVAILABLE");
    }
  });
  return app;
}

function currentBindingMatches(
  snapshot: Awaited<ReturnType<GatewayContext["controlPlane"]["getByRepositoryId"]>>,
  input: z.infer<typeof RuntimeAuthProbeRequestSchema>,
): snapshot is NonNullable<typeof snapshot> {
  return Boolean(
    snapshot &&
    !snapshot.binding.suspended &&
    snapshot.binding.repositoryId === input.repositoryId &&
    snapshot.binding.instanceId === input.instanceId &&
    snapshot.binding.authorizationRevision === input.authorizationRevision &&
    snapshot.instance.repositoryId === input.repositoryId &&
    snapshot.instance.instanceId === input.instanceId &&
    snapshot.instance.generation === input.generation &&
    snapshot.instance.runtimeEpoch === input.runtimeEpoch,
  );
}

function sameCurrentBinding(
  left: Awaited<ReturnType<GatewayContext["controlPlane"]["getByRepositoryId"]>>,
  right: Awaited<ReturnType<GatewayContext["controlPlane"]["getByRepositoryId"]>>,
): boolean {
  return Boolean(left && right &&
    left.binding.repositoryId === right.binding.repositoryId &&
    left.binding.instanceId === right.binding.instanceId &&
    left.binding.installationId === right.binding.installationId &&
    left.binding.bindingEpoch === right.binding.bindingEpoch &&
    left.binding.authorizationRevision === right.binding.authorizationRevision &&
    left.binding.suspended === right.binding.suspended &&
    left.instance.generation === right.instance.generation &&
    left.instance.runtimeEpoch === right.instance.runtimeEpoch);
}
