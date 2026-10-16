import {
  renderHandoff,
  renderPortalError,
  renderRepositoryDashboard,
  renderRepositoryList,
} from "./render.js";
import type {
  PortalCommand,
  PortalCommandResult,
  PortalHandlerDependencies,
  PortalModulePreview,
  PortalOperation,
  PortalRepositoryDashboard,
  PortalResult,
} from "./types.js";

const FORM_FIELDS = new Set([
  "csrfToken",
  "action",
  "expectedGeneration",
  "idempotencyKey",
  "releasePolicy",
  "releaseId",
  "moduleIds",
  "resourceProfileId",
  "operationId",
]);

type ParsedAction =
  | { readonly kind: "preview"; readonly command: Extract<PortalCommand, { kind: "preview" }> }
  | { readonly kind: "execute"; readonly command: Exclude<PortalCommand, { kind: "preview" }> };

interface ParsedForm {
  readonly values: FormData;
}

function errorStatus(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
    case "UNAUTHORIZED":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "STALE_GENERATION":
      return 409;
    case "INVALID_REQUEST":
      return 400;
    case "UNAVAILABLE":
    case "UPSTREAM_UNAVAILABLE":
      return 503;
    case "RATE_LIMITED":
      return 429;
    default:
      return 502;
  }
}

function withStatus(response: Response, status: number): Response {
  return new Response(response.body, { status, headers: response.headers });
}

function safeRepositoryId(value: string): string | null {
  if (
    value.length === 0 ||
    value.length > 256 ||
    value.includes("/") ||
    hasControlCharacter(value)
  ) {
    return null;
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function repositoryRoute(pathname: string): { repositoryId: string; action: boolean } | null {
  const match = /^\/repositories\/([^/]+)(\/actions)?$/.exec(pathname);
  if (!match) return null;
  let decodedId: string;
  try {
    decodedId = decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
  const repositoryId = safeRepositoryId(decodedId);
  return repositoryId ? { repositoryId, action: match[2] !== undefined } : null;
}

function single(form: FormData, name: string): string | null {
  const values = form.getAll(name);
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  return values[0];
}

function formString(form: FormData, name: string): string | null {
  const value = single(form, name);
  if (value === null || value.length === 0 || value.length > 256 || hasControlCharacter(value)) {
    return null;
  }
  return value;
}

function idempotencyKey(form: FormData): string | null {
  const value = formString(form, "idempotencyKey");
  return value && /^[A-Za-z0-9_-]{16,256}$/.test(value) ? value : null;
}

async function readForm(request: Request): Promise<ParsedForm | null> {
  if (
    request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  ) {
    return null;
  }
  const form = await request.formData().catch(() => null);
  if (!form || [...form.keys()].some((key) => !FORM_FIELDS.has(key))) return null;
  for (const [key, value] of form.entries()) {
    if (key !== "moduleIds" && typeof value !== "string") return null;
    if (typeof value === "string" && value.length > 4096) return null;
  }
  return { values: form };
}

function moduleIds(form: FormData): readonly string[] | null {
  const values = form.getAll("moduleIds");
  if (
    values.some((value) => typeof value !== "string" || value.length === 0 || value.length > 256)
  ) {
    return null;
  }
  const ids = values as string[];
  return new Set(ids).size === ids.length ? ids : null;
}

function expectedGeneration(form: FormData): number | null {
  const value = single(form, "expectedGeneration");
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const generation = Number(value);
  return Number.isSafeInteger(generation) ? generation : null;
}

function configurationFields(form: FormData): {
  readonly releasePolicy: "stable" | "pinned";
  readonly releaseId: string;
  readonly moduleIds: readonly string[];
  readonly resourceProfileId: string;
} | null {
  const policy = single(form, "releasePolicy");
  const releaseId = formString(form, "releaseId");
  const selectedModules = moduleIds(form);
  const resourceProfileId = formString(form, "resourceProfileId");
  if (
    (policy !== "stable" && policy !== "pinned") ||
    releaseId === null ||
    selectedModules === null ||
    resourceProfileId === null
  ) {
    return null;
  }
  return {
    releasePolicy: policy,
    releaseId,
    moduleIds: selectedModules,
    resourceProfileId,
  };
}

function parseAction(form: FormData): ParsedAction | null {
  const action = single(form, "action");
  if (action === "preview") {
    const config = configurationFields(form);
    if (!config) return null;
    return { kind: "preview", command: { kind: "preview", ...config } };
  }
  if (action === "configure") {
    const config = configurationFields(form);
    const generation = expectedGeneration(form);
    const key = idempotencyKey(form);
    if (!config || generation === null || !key) return null;
    return {
      kind: "execute",
      command: {
        kind: "configure",
        expectedGeneration: generation,
        idempotencyKey: key,
        ...config,
      },
    };
  }
  if (action === "redeploy") {
    const generation = expectedGeneration(form);
    const key = idempotencyKey(form);
    if (generation === null || !key) return null;
    return {
      kind: "execute",
      command: { kind: "redeploy", expectedGeneration: generation, idempotencyKey: key },
    };
  }
  if (action === "retry") {
    const operationId = formString(form, "operationId");
    const key = idempotencyKey(form);
    if (!operationId || !key) return null;
    return { kind: "execute", command: { kind: "retry", operationId, idempotencyKey: key } };
  }
  if (action === "enter") {
    return { kind: "execute", command: { kind: "enter" } };
  }
  return null;
}

function pagePollCount(url: URL): number {
  const value = url.searchParams.get("poll");
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(parsed, 5) : 0;
}

function makeDashboardResponse(
  dashboard: PortalRepositoryDashboard,
  dependencies: PortalHandlerDependencies,
  session: { readonly csrfToken: string },
  options: {
    readonly preview?: PortalModulePreview;
    readonly notice?: PortalOperation;
    readonly errorMessage?: string;
    readonly pollCount?: number;
  } = {},
): Response {
  const operationInProgress =
    options.notice?.state === "queued" ||
    options.notice?.state === "running" ||
    dashboard.operations.some(
      (operation) => operation.state === "queued" || operation.state === "running",
    );
  return renderRepositoryDashboard(dashboard, {
    csrfToken: session.csrfToken,
    createIdempotencyKey: dependencies.createToken,
    ...(options.preview ? { preview: options.preview } : {}),
    ...(options.notice ? { notice: options.notice } : {}),
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    ...(options.pollCount !== undefined ? { pollCount: options.pollCount } : {}),
    ...(operationInProgress ? { scriptNonce: dependencies.createToken() } : {}),
  });
}

async function loadDashboard(
  dependencies: PortalHandlerDependencies,
  actor: { readonly userId: string },
  repositoryId: string,
): Promise<PortalResult<PortalRepositoryDashboard>> {
  try {
    return await dependencies.service.getRepository(actor, repositoryId);
  } catch {
    return {
      ok: false,
      error: { code: "UNAVAILABLE", message: "Repository status is temporarily unavailable." },
    };
  }
}

function requireCommandResult<T extends PortalCommandResult["kind"]>(
  result: PortalResult<PortalCommandResult>,
  kind: T,
): PortalResult<Extract<PortalCommandResult, { kind: T }>> {
  if (!result.ok) return result;
  if (result.value.kind !== kind) {
    return {
      ok: false,
      error: { code: "FAILED", message: "The application service returned an unexpected result." },
    };
  }
  return { ok: true, value: result.value as Extract<PortalCommandResult, { kind: T }> };
}

/**
 * Native Request/Response adapter for the Gateway router. The Gateway mounts
 * GET `/`, GET `/repositories/:id`, and POST `/repositories/:id/actions`.
 */
export function createPortalHandler(
  dependencies: PortalHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const route = url.pathname === "/" ? null : repositoryRoute(url.pathname);
    const isList = url.pathname === "/" && request.method === "GET";
    const isDetail = route !== null && !route.action && request.method === "GET";
    const isAction = route !== null && route.action && request.method === "POST";
    if (!isList && !isDetail && !isAction) {
      return renderPortalError("Page not found.", 404);
    }

    let identity;
    try {
      identity = await dependencies.authenticate(request);
    } catch {
      return renderPortalError("Your session could not be checked. Sign in again.", 503);
    }
    if (!identity.ok) return identity.response;

    if (isList) {
      try {
        const result = await dependencies.service.listRepositories(identity.session.actor);
        return result.ok
          ? renderRepositoryList(result.value, identity.session.csrfToken)
          : renderPortalError(result.error.message, errorStatus(result.error.code));
      } catch {
        return renderPortalError("Repository status is temporarily unavailable.", 503);
      }
    }

    if (!route) return renderPortalError("Repository not found.", 404);
    if (isDetail) {
      const result = await loadDashboard(dependencies, identity.session.actor, route.repositoryId);
      return result.ok
        ? makeDashboardResponse(result.value, dependencies, identity.session, {
            pollCount: pagePollCount(url),
          })
        : renderPortalError(result.error.message, errorStatus(result.error.code));
    }

    if (!(await dependencies.verifyCsrf(request, identity.session))) {
      return renderPortalError(
        "The request could not be verified. Reload the page and try again.",
        403,
      );
    }
    const parsed = await readForm(request);
    const action = parsed ? parseAction(parsed.values) : null;
    if (!action) return renderPortalError("The submitted action was invalid.", 400);

    let result: PortalResult<PortalCommandResult>;
    try {
      result = await dependencies.service.execute(
        identity.session.actor,
        route.repositoryId,
        action.command,
      );
    } catch {
      return renderPortalError("The requested operation is temporarily unavailable.", 503);
    }
    if (!result.ok) {
      const dashboard = await loadDashboard(
        dependencies,
        identity.session.actor,
        route.repositoryId,
      );
      if (dashboard.ok) {
        return withStatus(
          makeDashboardResponse(dashboard.value, dependencies, identity.session, {
            errorMessage: result.error.message,
          }),
          errorStatus(result.error.code),
        );
      }
      return renderPortalError(result.error.message, errorStatus(result.error.code));
    }

    if (action.kind === "preview") {
      const preview = requireCommandResult(result, "preview");
      const dashboard = await loadDashboard(
        dependencies,
        identity.session.actor,
        route.repositoryId,
      );
      if (!preview.ok)
        return renderPortalError(preview.error.message, errorStatus(preview.error.code));
      if (!dashboard.ok)
        return renderPortalError(dashboard.error.message, errorStatus(dashboard.error.code));
      return makeDashboardResponse(dashboard.value, dependencies, identity.session, {
        preview: preview.value.preview,
      });
    }

    if (action.command.kind === "enter") {
      if (result.value.kind === "handoff") {
        return renderHandoff(result.value.handoff, dependencies.createToken());
      }
      const start = requireCommandResult(result, "operation");
      if (!start.ok) return renderPortalError(start.error.message, errorStatus(start.error.code));
      const dashboard = await loadDashboard(
        dependencies,
        identity.session.actor,
        route.repositoryId,
      );
      return dashboard.ok
        ? withStatus(
            makeDashboardResponse(dashboard.value, dependencies, identity.session, {
              notice: start.value.operation,
            }),
            202,
          )
        : renderPortalError(dashboard.error.message, errorStatus(dashboard.error.code));
    }

    const commandResult = requireCommandResult(result, "operation");
    if (!commandResult.ok)
      return renderPortalError(commandResult.error.message, errorStatus(commandResult.error.code));
    const dashboard = await loadDashboard(dependencies, identity.session.actor, route.repositoryId);
    return dashboard.ok
      ? makeDashboardResponse(dashboard.value, dependencies, identity.session, {
          notice: commandResult.value.operation,
        })
      : renderPortalError(dashboard.error.message, errorStatus(dashboard.error.code));
  };
}
