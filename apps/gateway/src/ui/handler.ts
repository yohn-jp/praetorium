import {
  resolvePresentation,
  type ConfigurationSelection,
  type PortalPresentation,
} from "./presentation.js";
import {
  renderHandoff,
  renderAcceptedCommand,
  renderPortalError as renderError,
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
const MAX_PORTAL_FORM_BYTES = 64 * 1024;

type ParsedAction =
  | { readonly kind: "preview"; readonly command: Extract<PortalCommand, { kind: "preview" }> }
  | { readonly kind: "execute"; readonly command: Exclude<PortalCommand, { kind: "preview" }> };

interface ParsedForm {
  readonly values: FormData;
}

type FormReadResult =
  | { readonly kind: "valid"; readonly form: ParsedForm }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" };

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

async function readForm(request: Request): Promise<FormReadResult> {
  const rawLength = request.headers.get("Content-Length");
  if (rawLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(rawLength)) return { kind: "invalid" };
    if (Number(rawLength) > MAX_PORTAL_FORM_BYTES) return { kind: "too-large" };
  }
  if (
    request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  ) {
    return { kind: "invalid" };
  }
  const reader = request.body?.getReader();
  if (!reader) return { kind: "invalid" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PORTAL_FORM_BYTES) {
        await reader.cancel();
        return { kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "invalid" };
  }
  if (rawLength !== null && Number(rawLength) !== size) return { kind: "invalid" };
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { kind: "invalid" };
  }
  const form = new FormData();
  for (const [key, value] of new URLSearchParams(body)) form.append(key, value);
  if ([...form.keys()].some((key) => !FORM_FIELDS.has(key))) return { kind: "invalid" };
  for (const [key, value] of form.entries()) {
    if (key !== "moduleIds" && typeof value !== "string") return { kind: "invalid" };
    if (typeof value === "string" && value.length > 4096) return { kind: "invalid" };
  }
  return { kind: "valid", form: { values: form } };
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
  if (action === "stop") {
    const generation = expectedGeneration(form);
    const key = idempotencyKey(form);
    if (generation === null || !key) return null;
    return {
      kind: "execute",
      command: { kind: "stop", expectedGeneration: generation, idempotencyKey: key },
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

function dashboardResponse(
  dashboard: PortalRepositoryDashboard,
  dependencies: PortalHandlerDependencies,
  session: { readonly csrfToken: string },
  options: {
    readonly presentation?: PortalPresentation;
    readonly selection?: ConfigurationSelection;
    readonly preview?: PortalModulePreview;
    readonly notice?: PortalOperation;
    readonly acceptedConfiguration?: { readonly revisionId: string; readonly buildId: string };
    readonly errorMessage?: string;
    readonly pollCount?: number;
    readonly requestId?: string;
  } = {},
): Response {
  return renderRepositoryDashboard(dashboard, {
    ...(options.selection ? { selection: options.selection } : {}),
    ...(options.presentation ? { presentation: options.presentation } : {}),
    csrfToken: session.csrfToken,
    createIdempotencyKey: dependencies.createToken,
    ...(options.preview ? { preview: options.preview } : {}),
    ...(options.notice ? { notice: options.notice } : {}),
    ...(options.acceptedConfiguration ? { acceptedConfiguration: options.acceptedConfiguration } : {}),
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    ...(options.pollCount !== undefined ? { pollCount: options.pollCount } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    scriptNonce: dependencies.createToken(),
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
  const handle = async (request: Request, presentation: PortalPresentation): Promise<Response> => {
    const renderPortalError = (message: string, status = 503) =>
      renderError(message, status, presentation);
    const makeDashboardResponse = (
      dashboard: PortalRepositoryDashboard,
      deps: PortalHandlerDependencies,
      session: { readonly csrfToken: string },
      options: Parameters<typeof dashboardResponse>[3] = {},
    ) =>
      dashboardResponse(dashboard, deps, session, {
        ...options,
        presentation: { ...presentation, repositoryId: dashboard.repository.repositoryId },
      });
    const url = new URL(request.url);
    const route = url.pathname === "/" ? null : repositoryRoute(url.pathname);
    const isList = url.pathname === "/" && request.method === "GET";
    const isDetail = route !== null && !route.action && request.method === "GET";
    const isAction = route !== null && route.action && request.method === "POST";
    if (!isList && !isDetail && !isAction) {
      return renderPortalError("Page not found.", 404);
    }

    let parsedForm: ParsedForm | null = null;
    if (isAction) {
      const result = await readForm(request);
      if (result.kind === "too-large") {
        return renderPortalError("The submitted form is too large.", 413);
      }
      if (result.kind === "invalid") {
        return renderPortalError("The submitted action was invalid.", 400);
      }
      parsedForm = result.form;
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
          ? renderRepositoryList(result.value, identity.session.csrfToken, presentation)
          : renderPortalError(result.error.message, errorStatus(result.error.code));
      } catch {
        return renderPortalError("Repository status is temporarily unavailable.", 503);
      }
    }

    if (!route) return renderPortalError("Repository not found.", 404);
    if (isDetail) {
      const result = await loadDashboard(dependencies, identity.session.actor, route.repositoryId);
      const requestIds = url.searchParams.getAll("requestId");
      const requestId = requestIds.length === 1 && /^[A-Za-z0-9_-]{1,256}$/.test(requestIds[0]!) ? requestIds[0] : undefined;
      if (!result.ok && requestId &&
          (result.error.code === "UNAVAILABLE" || result.error.code === "UPSTREAM_UNAVAILABLE")) {
        return renderAcceptedCommand(route.repositoryId, presentation, [requestId], dependencies.createToken(), false);
      }
      return result.ok
        ? makeDashboardResponse(result.value, dependencies, identity.session, {
            pollCount: pagePollCount(url),
            ...(requestId ? { requestId } : {}),
          })
        : renderPortalError(result.error.message, errorStatus(result.error.code));
    }

    if (!(await dependencies.verifyCsrf(request, identity.session, parsedForm!.values))) {
      return renderPortalError(
        "The request could not be verified. Reload the page and try again.",
        403,
      );
    }
    const action = parseAction(parsedForm!.values);
    if (!action) return renderPortalError("The submitted action was invalid.", 400);

    let result: PortalResult<PortalCommandResult>;
    try {
      result = await dependencies.service.execute(
        identity.session.actor,
        route.repositoryId,
        action.command,
      );
    } catch {
      result = {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "The requested operation is temporarily unavailable.",
        },
      };
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
            ...(action.command.kind === "preview" || action.command.kind === "configure"
              ? { selection: action.command }
              : {}),
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
        selection: action.command,
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
        : renderAcceptedCommand(route.repositoryId, presentation, [start.value.operation.operationId], dependencies.createToken());
    }

    if (result.value.kind === "configuration") {
      const accepted = result.value;
      const dashboard = await loadDashboard(
        dependencies,
        identity.session.actor,
        route.repositoryId,
      );
      return dashboard.ok
        ? withStatus(makeDashboardResponse(dashboard.value, dependencies, identity.session, { acceptedConfiguration: accepted }), 202)
        : renderAcceptedCommand(route.repositoryId, presentation, [accepted.revisionId, accepted.buildId], dependencies.createToken());
    }

    const commandResult = requireCommandResult(result, "operation");
    if (!commandResult.ok)
      return renderPortalError(commandResult.error.message, errorStatus(commandResult.error.code));
    const dashboard = await loadDashboard(dependencies, identity.session.actor, route.repositoryId);
    return dashboard.ok
      ? withStatus(
          makeDashboardResponse(dashboard.value, dependencies, identity.session, {
            notice: commandResult.value.operation,
          }),
          202,
        )
      : renderAcceptedCommand(route.repositoryId, presentation, [commandResult.value.operation.operationId], dependencies.createToken());
  };
  return async (request) => {
    const selection = resolvePresentation(request);
    const requestUrl = new URL(request.url);
    const route = repositoryRoute(requestUrl.pathname);
    const queries = requestUrl.searchParams.getAll("q");
    const repositoryQuery = requestUrl.pathname === "/" && queries.length === 1 && queries[0]!.length <= 256 && !Array.from(queries[0]!).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ? queries[0] : undefined;
    const response = await handle(request, {
      mode: selection.mode,
      offerModeChoice: selection.offerModeChoice,
      ...(repositoryQuery ? { repositoryQuery } : {}),
      ...(route ? { repositoryId: route.repositoryId } : {}),
    });
    if (!selection.cookie) return response;
    const headers = new Headers(response.headers);
    headers.append("Set-Cookie", selection.cookie);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
