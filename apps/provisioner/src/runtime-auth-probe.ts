import { createHash } from "node:crypto";
import { AccessGrantSchema, type AccessGrant } from "@praetorium/contracts";
import type {
  LifecycleAuthProbeProvider,
  RuntimeAssignment,
} from "@praetorium/application/lifecycle";
import type { ClaimedProvisionerOperation } from "./operation-client.js";

const MAX_CONTROL_RESPONSE_BYTES = 32 * 1024;
const MAX_APPLICATION_RESPONSE_BYTES = 14 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const ACCESS_COOKIE = "__Host-praetorium_access";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const INVALID_CONTROL_CREDENTIAL = "invalid-runtime-control-probe-credential";

const ProbeGrantResponseSchema = AccessGrantSchema;

export interface RuntimeAuthProbeAssignmentIdentity {
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly clusterId: string;
  readonly revisionId: string;
  readonly imageDigest: string;
  readonly platformManifestDigest: string;
  readonly compositionManifestDigest: string;
  readonly enabledModuleIds: readonly string[];
  readonly grantPolicy: RuntimeAssignment["deployment"]["grantPolicy"];
  readonly controlServicePolicy: RuntimeAssignment["deployment"]["controlServicePolicy"];
}

export type RuntimeAuthProbeScope =
  | {
      readonly mode: "lease";
      readonly operationId: string;
      readonly workerId: string;
      readonly leaseToken: string;
      readonly leaseEpoch: number;
    }
  | {
      readonly mode: "observed";
      readonly operationId: string;
    };

export type RuntimeAuthProbeEndpointResolver = (
  assignment: RuntimeAssignment,
  signal?: AbortSignal,
) => Promise<string>;

export interface HttpRuntimeAuthAcceptanceProbeOptions {
  readonly controlPlaneUrl: string;
  readonly provisionerCredential: string;
  readonly workerId: string;
  readonly clusterId: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly scope?: () => RuntimeAuthProbeScope;
  readonly resolveRuntimeEndpoint?: RuntimeAuthProbeEndpointResolver;
}

export interface RuntimeAuthAcceptanceEvidence extends Awaited<ReturnType<LifecycleAuthProbeProvider["verify"]>> {
  readonly uiApiMcpProbeId: string;
  readonly persistenceProbeId: string;
}

/**
 * Calls the real internal Control Plane authority and then the assigned
 * Scriptorium HTTP routes. Grants exist only in this trusted worker's memory;
 * evidence contains hashes and statuses, never repository content or tokens.
 */
export class HttpRuntimeAuthAcceptanceProbe implements LifecycleAuthProbeProvider {
  readonly available = true;

  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpRuntimeAuthAcceptanceProbeOptions) {
    const controlPlane = new URL(options.controlPlaneUrl);
    if (
      (controlPlane.protocol !== "https:" &&
        !(controlPlane.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(controlPlane.hostname))) ||
      controlPlane.username || controlPlane.password || controlPlane.search || controlPlane.hash ||
      controlPlane.pathname !== "/"
    ) throw new TypeError("invalid runtime auth probe Control Plane URL");
    if (options.provisionerCredential.length < 16 || options.provisionerCredential.length > 4_096 ||
        /[\r\n]/u.test(options.provisionerCredential)) {
      throw new TypeError("invalid runtime auth probe credential");
    }
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(options.workerId) ||
        !/^[A-Za-z0-9_.:-]{1,128}$/u.test(options.clusterId)) {
      throw new TypeError("invalid runtime auth probe worker identity");
    }
    this.fetchImplementation = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new TypeError("invalid runtime auth probe timeout");
    }
  }

  async verify(
    assignment: RuntimeAssignment,
    signal?: AbortSignal,
  ): Promise<RuntimeAuthAcceptanceEvidence> {
    const scope = this.options.scope?.();
    if (!scope) throw new Error("runtime_auth_probe_operation_scope_unavailable");
    return this.verifyWithScope(assignment, scope, signal);
  }

  /** Repeats the probe for a successful operation still serving the same writer. */
  verifyObserved(
    assignment: RuntimeAssignment,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<RuntimeAuthAcceptanceEvidence> {
    return this.verifyWithScope(assignment, { mode: "observed", operationId }, signal);
  }

  /** Binds pre-activation evidence to this exact claimed operation lease. */
  forLease(
    claim: ClaimedProvisionerOperation,
    workerId = this.options.workerId,
  ): HttpRuntimeAuthAcceptanceProbe {
    const operation = claim.operation;
    const scope: RuntimeAuthProbeScope = {
      mode: "lease",
      operationId: operation.id,
      workerId,
      leaseToken: operation.leaseToken,
      leaseEpoch: operation.leaseEpoch,
    };
    return new HttpRuntimeAuthAcceptanceProbe({
      ...this.options,
      scope: () => scope,
    });
  }

  /** Bind runtime requests to the provider-verified owned Service address. */
  withEndpointResolver(resolveRuntimeEndpoint: RuntimeAuthProbeEndpointResolver): HttpRuntimeAuthAcceptanceProbe {
    return new HttpRuntimeAuthAcceptanceProbe({ ...this.options, resolveRuntimeEndpoint });
  }

  private async verifyWithScope(
    assignment: RuntimeAssignment,
    scope: RuntimeAuthProbeScope,
    signal?: AbortSignal,
  ): Promise<RuntimeAuthAcceptanceEvidence> {
    const startedAt = this.now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error("runtime_auth_probe_clock_invalid");
    const assignmentIdentity = identityOf(assignment);
    const origin = runtimeOrigin(assignment.deployment.hostname);
    const resolveRuntimeEndpoint = this.options.resolveRuntimeEndpoint;
    if (!resolveRuntimeEndpoint) throw new Error("runtime_auth_probe_internal_endpoint_unavailable");
    const endpointUrl = await resolveRuntimeEndpoint(assignment, signal);
    const transport = runtimeApplicationTransport(endpointUrl, origin);
    const grants = await this.requestGrantMaterial(scope, assignmentIdentity, signal);
    const grantsReceivedAt = this.now();
    if (!Number.isSafeInteger(grantsReceivedAt) || grantsReceivedAt < 0) {
      throw new Error("runtime_auth_probe_clock_invalid");
    }
    const grantSet = validateGrantSet(grants, assignment, Math.floor(grantsReceivedAt / 1_000));
    if (grantSet.origin !== origin || grantSet.audience !== assignment.deployment.grantPolicy.audience) {
      throw new Error("runtime_auth_probe_grant_policy_mismatch");
    }

    const identity = assignmentIdentity;

    const ui = await probeUi(
      this.fetchImplementation,
      transport,
      grantSet.validGrant,
      grantSet.validClaims.sub,
      signal,
      this.timeoutMs,
    );
    const api = await probeApi(this.fetchImplementation, transport, grantSet.validGrant, assignment, signal, this.timeoutMs);
    const persistence = await probePersistence(
      this.fetchImplementation,
      transport,
      grantSet.validGrant,
      assignment,
      api.projectId,
      signal,
      this.timeoutMs,
    );
    const mcp = await probeMcp(
      this.fetchImplementation,
      transport,
      grantSet.validGrant,
      assignment,
      api.projectId,
      signal,
      this.timeoutMs,
    );
    const wrongRepository = await probeRejectedGrant(
      this.fetchImplementation,
      transport,
      grantSet.wrongRepositoryGrant,
      "/api/projects",
      signal,
      this.timeoutMs,
    );
    const wrongEpoch = await probeRejectedGrant(
      this.fetchImplementation,
      transport,
      grantSet.wrongEpochGrant,
      "/api/projects",
      signal,
      this.timeoutMs,
    );
    const invalidControl = await probeInvalidControlCredential(
      this.fetchImplementation,
      transport,
      assignment.deployment.runtimeMetadata.statusPath,
      signal,
      this.timeoutMs,
    );

    const completedAt = this.now();
    if (!Number.isSafeInteger(completedAt) || completedAt < startedAt) {
      throw new Error("runtime_auth_probe_clock_invalid");
    }
    const observedAt = new Date(completedAt).toISOString();

    const uiApiMcpProbeId = evidenceId("runtime-auth-ui-api-mcp", {
      assignment: identity,
      ui,
      api: api.evidence,
      mcp,
      observedAt,
    });
    const persistenceProbeId = evidenceId("runtime-auth-persistence-read", {
      assignment: identity,
      persistence,
      observedAt,
    });
    const validGrantProbeId = evidenceId("runtime-auth-valid-grant", {
      assignment: identity,
      grantSubject: grantSet.validClaims.sub,
      ui: ui.evidence,
      api: api.evidence,
      mcp,
      observedAt,
    });
    const wrongRepositoryProbeId = evidenceId("runtime-auth-wrong-repository", {
      assignment: identity,
      response: wrongRepository,
      observedAt,
    });
    const wrongEpochProbeId = evidenceId("runtime-auth-wrong-epoch", {
      assignment: identity,
      response: wrongEpoch,
      observedAt,
    });
    const invalidServiceCredentialProbeId = evidenceId("runtime-auth-invalid-control-credential", {
      assignment: identity,
      response: invalidControl,
      observedAt,
    });
    const applicationProbeId = evidenceId("runtime-auth-application", {
      assignment: identity,
      uiApiMcpProbeId,
      persistenceProbeId,
      wrongRepositoryProbeId,
      wrongEpochProbeId,
      invalidServiceCredentialProbeId,
      observedAt,
    });

    return {
      applicationProbeId,
      uiApiMcpProbeId,
      persistenceProbeId,
      grantPolicyMatched: grantSet.grantPolicyMatched,
      controlServicePolicyMatched: grantSet.controlServicePolicyMatched,
      validGrantAccepted: ui.accepted && api.accepted && mcp.accepted,
      wrongRepositoryGrantRejected: wrongRepository.rejected,
      wrongEpochGrantRejected: wrongEpoch.rejected,
      invalidServiceCredentialRejected: invalidControl.rejected,
      validGrantProbeId,
      wrongRepositoryProbeId,
      wrongEpochProbeId,
      invalidServiceCredentialProbeId,
      observedAt,
    };
  }

  private async requestGrantMaterial(
    scope: RuntimeAuthProbeScope,
    assignment: RuntimeAuthProbeAssignmentIdentity,
    signal?: AbortSignal,
  ): Promise<GrantSetResponse> {
    const operationId = scope.operationId;
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(operationId)) throw new TypeError("invalid runtime auth probe operation ID");
    const body = scope.mode === "lease"
      ? {
          mode: "lease" as const,
          workerId: scope.workerId,
          leaseToken: scope.leaseToken,
          leaseEpoch: scope.leaseEpoch,
          assignment,
        }
      : { mode: "observed" as const, assignment };
    const url = new URL(
      `/internal/provisioner/operations/${encodeURIComponent(operationId)}/auth-probe`,
      this.options.controlPlaneUrl,
    );
    const response = await this.fetchResponse(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.options.provisionerCredential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, MAX_CONTROL_RESPONSE_BYTES, signal);
    if (!response.ok) {
      throw new RuntimeAuthProbeHttpError("runtime_auth_probe_authority_rejected", response.status);
    }
    if (!/\bno-store\b/iu.test(response.headers.get("Cache-Control") ?? "")) {
      throw new TypeError("runtime auth grant response must be non-cacheable");
    }
    return parseGrantSetResponse(parseJson<unknown>(response.bytes, "runtime auth grant response is invalid"));
  }

  private async fetchResponse(
    url: URL,
    init: RequestInit,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<BoundedResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        ...init,
        redirect: "error",
        cache: "no-store",
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new RuntimeAuthProbeHttpError("runtime_auth_probe_unavailable", 0);
    }
    const bytes = await readBounded(response, maximumBytes);
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      bytes,
      bodyDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      method: (init.method ?? "GET").toUpperCase(),
      path: url.pathname,
    };
  }
}

export class RuntimeAuthProbeHttpError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "RuntimeAuthProbeHttpError";
  }
}

interface GrantSetResponse {
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly origin: string;
  readonly audience: string;
  readonly authorizationRevision: number;
  readonly grantPolicyMatched: true;
  readonly controlServicePolicyMatched: true;
  readonly validGrant: string;
  readonly wrongRepositoryGrant: string;
  readonly wrongEpochGrant: string;
  readonly permissions: readonly AccessGrant["permissions"][number][];
}

interface ValidatedGrantSet extends GrantSetResponse {
  readonly validClaims: AccessGrant;
}

interface BoundedResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
  readonly bodyDigest: string;
  readonly method: string;
  readonly path: string;
}

interface ExchangeEvidence {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly bodyDigest: string;
}

interface ProbeResult {
  readonly accepted: boolean;
  readonly evidence: ExchangeEvidence;
}

interface RejectionResult {
  readonly rejected: boolean;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly bodyDigest: string;
}

function identityOf(assignment: RuntimeAssignment): RuntimeAuthProbeAssignmentIdentity {
  return {
    instanceId: assignment.instanceId,
    repositoryId: assignment.repositoryId,
    generation: assignment.generation,
    runtimeEpoch: assignment.runtimeEpoch,
    clusterId: assignment.clusterId,
    revisionId: assignment.deployment.revisionId,
    imageDigest: assignment.deployment.imageDigest,
    platformManifestDigest: assignment.deployment.platformManifestDigest,
    compositionManifestDigest: assignment.deployment.compositionManifestDigest,
    enabledModuleIds: [...assignment.deployment.enabledModuleIds].sort(),
    grantPolicy: assignment.deployment.grantPolicy,
    controlServicePolicy: assignment.deployment.controlServicePolicy,
  };
}

function runtimeOrigin(hostname: string): string {
  const parsed = new URL(`https://${hostname}`);
  if (parsed.origin !== `https://${hostname}` || parsed.username || parsed.password || parsed.pathname !== "/") {
    throw new TypeError("runtime hostname is invalid");
  }
  return parsed.origin;
}

interface RuntimeApplicationTransport {
  readonly endpoint: URL;
  readonly origin: string;
}

function runtimeApplicationTransport(endpoint: string, origin: string): RuntimeApplicationTransport {
  const service = new URL(endpoint);
  const publicUrl = new URL(origin);
  if (
    service.protocol !== "http:" ||
    service.username ||
    service.password ||
    service.pathname !== "/" ||
    service.search ||
    service.hash ||
    service.hostname === publicUrl.hostname ||
    !service.hostname.endsWith(".svc.cluster.local")
  ) throw new TypeError("runtime auth probes require the provider-owned in-cluster Service endpoint");
  return { endpoint: service, origin };
}

function validateGrantSet(input: GrantSetResponse, assignment: RuntimeAssignment, nowSeconds: number): ValidatedGrantSet {
  if (
    input.issuer !== assignment.deployment.grantPolicy.issuer ||
    input.jwksUrl !== assignment.deployment.grantPolicy.jwksUrl ||
    input.audience !== assignment.deployment.grantPolicy.audience ||
    input.grantPolicyMatched !== true ||
    input.controlServicePolicyMatched !== true ||
    !Number.isSafeInteger(input.authorizationRevision) ||
    input.authorizationRevision < 0 ||
    input.permissions.length !== 1 ||
    input.permissions[0] !== "read"
  ) throw new TypeError("runtime auth probe policy response is invalid");
  const validClaims = parseGrantClaims(input.validGrant);
  const wrongRepositoryClaims = parseGrantClaims(input.wrongRepositoryGrant);
  const wrongEpochClaims = parseGrantClaims(input.wrongEpochGrant);
  const target = assignment;
  if (
    validClaims.iss !== input.issuer ||
    validClaims.aud !== input.audience ||
    validClaims.instanceId !== target.instanceId ||
    validClaims.repositoryId !== target.repositoryId ||
    validClaims.runtimeEpoch !== target.runtimeEpoch ||
    validClaims.authorizationRevision !== input.authorizationRevision ||
    validClaims.permissions.length !== 1 ||
    validClaims.permissions[0] !== "read" ||
    validClaims.permissions.length !== input.permissions.length ||
    validClaims.permissions.some((permission) => !input.permissions.includes(permission)) ||
    validClaims.iat > nowSeconds ||
    validClaims.nbf > nowSeconds ||
    validClaims.exp <= nowSeconds ||
    validClaims.exp - nowSeconds > 61 ||
    wrongRepositoryClaims.sub !== validClaims.sub ||
    wrongRepositoryClaims.iss !== validClaims.iss ||
    wrongRepositoryClaims.aud !== validClaims.aud ||
    wrongRepositoryClaims.repositoryId === target.repositoryId ||
    wrongRepositoryClaims.instanceId !== target.instanceId ||
    wrongRepositoryClaims.runtimeEpoch !== target.runtimeEpoch ||
    wrongRepositoryClaims.permissions.length !== 1 ||
    wrongRepositoryClaims.permissions[0] !== "read" ||
    wrongRepositoryClaims.authorizationRevision !== validClaims.authorizationRevision ||
    wrongEpochClaims.sub !== validClaims.sub ||
    wrongEpochClaims.iss !== validClaims.iss ||
    wrongEpochClaims.aud !== validClaims.aud ||
    wrongEpochClaims.repositoryId !== target.repositoryId ||
    wrongEpochClaims.instanceId !== target.instanceId ||
    wrongEpochClaims.runtimeEpoch === target.runtimeEpoch ||
    wrongEpochClaims.permissions.length !== 1 ||
    wrongEpochClaims.permissions[0] !== "read" ||
    wrongEpochClaims.authorizationRevision !== validClaims.authorizationRevision ||
    wrongRepositoryClaims.exp !== validClaims.exp ||
    wrongEpochClaims.exp !== validClaims.exp
  ) throw new TypeError("runtime auth probe grant binding is invalid");
  return { ...input, validClaims };
}

function parseGrantSetResponse(value: unknown): GrantSetResponse {
  if (!object(value)) throw new TypeError("runtime auth grant response is invalid");
  const keys = [
    "issuer", "jwksUrl", "origin", "audience", "authorizationRevision",
    "grantPolicyMatched", "controlServicePolicyMatched", "validGrant",
    "wrongRepositoryGrant", "wrongEpochGrant", "permissions",
  ];
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key))) {
    throw new TypeError("runtime auth grant response shape is invalid");
  }
  const permissionSet = new Set(["read", "write", "maintain", "admin"]);
  if (
    typeof value["issuer"] !== "string" ||
    typeof value["jwksUrl"] !== "string" ||
    typeof value["origin"] !== "string" ||
    typeof value["audience"] !== "string" ||
    !Number.isSafeInteger(value["authorizationRevision"]) ||
    value["grantPolicyMatched"] !== true ||
    value["controlServicePolicyMatched"] !== true ||
    typeof value["validGrant"] !== "string" || value["validGrant"].length < 16 || value["validGrant"].length > 16_384 ||
    typeof value["wrongRepositoryGrant"] !== "string" || value["wrongRepositoryGrant"].length < 16 || value["wrongRepositoryGrant"].length > 16_384 ||
    typeof value["wrongEpochGrant"] !== "string" || value["wrongEpochGrant"].length < 16 || value["wrongEpochGrant"].length > 16_384 ||
    !Array.isArray(value["permissions"]) ||
    value["permissions"].some((permission) => typeof permission !== "string" || !permissionSet.has(permission))
  ) throw new TypeError("runtime auth grant response fields are invalid");
  return value as unknown as GrantSetResponse;
}

function parseGrantClaims(token: string): AccessGrant {
  if (typeof token !== "string" || token.length > 16_384) throw new TypeError("runtime auth grant is invalid");
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/u.test(parts[1]!)) throw new TypeError("runtime auth grant is invalid");
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
  return ProbeGrantResponseSchema.parse(claims);
}

async function probeUi(
  fetcher: typeof fetch,
  transport: RuntimeApplicationTransport,
  token: string,
  expectedUserId: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ProbeResult> {
  const cookie = `${ACCESS_COOKIE}=${encodeURIComponent(token)}`;
  const page = await request(fetcher, transport, "/", {
    headers: { Accept: "text/html", Cookie: cookie },
  }, signal, timeoutMs, 2 * 1024 * 1024);
  const pageType = page.headers.get("Content-Type")?.split(";", 1)[0]?.toLowerCase();
  if (!page.ok || page.status < 200 || page.status >= 300 || pageType !== "text/html") {
    throw new Error("runtime_ui_grant_rejected");
  }
  const session = await request(fetcher, transport, "/api/session", {
    headers: { Accept: "application/json", Cookie: cookie },
  }, signal, timeoutMs, 64 * 1024);
  const sessionBody = requireJsonRecord(session);
  const sessionPermissions = sessionBody["permissions"];
  if (
    !session.ok ||
    sessionBody["authenticated"] !== true ||
    sessionBody["authorScope"] !== `hosted:${expectedUserId}` ||
    !Array.isArray(sessionPermissions) ||
    sessionPermissions.length !== 1 ||
    sessionPermissions[0] !== "read"
  ) throw new Error("runtime_ui_session_rejected");
  return {
    accepted: true,
    evidence: {
      method: "GET",
      path: "/",
      status: page.status,
      contentType: pageType,
      bodyDigest: evidenceId("ui", {
        page: exchangeEvidence(page),
        session: exchangeEvidence(session),
        authenticated: true,
      authorScope: `hosted:${expectedUserId}`,
      permissions: sessionPermissions,
      }),
    },
  };
}

async function probeApi(
  fetcher: typeof fetch,
  transport: RuntimeApplicationTransport,
  token: string,
  assignment: RuntimeAssignment,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ readonly accepted: boolean; readonly projectId: string; readonly evidence: ExchangeEvidence }> {
  const response = await request(fetcher, transport, "/api/projects", {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  }, signal, timeoutMs, 2 * 1024 * 1024);
  if (!response.ok) throw new Error("runtime_api_grant_rejected");
  const projects = parseJson<unknown>(response.bytes, "runtime project list is invalid");
  if (!Array.isArray(projects) || projects.length < 1 || projects.length > 256) {
    throw new Error("runtime_assigned_project_missing");
  }
  const repositoryUrl = canonicalRepositoryUrl(assignment.deployment.repositoryLocator);
  const matching = projects.filter((value): value is Record<string, unknown> =>
    object(value) && canonicalRepositoryUrl(textProperty(value, "url")) === repositoryUrl);
  if (matching.length !== 1 || matching.length !== projects.length) {
    throw new Error("runtime_repository_scope_mismatch");
  }
  const projectId = textProperty(matching[0]!, "id");
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(projectId)) throw new Error("runtime_assigned_project_invalid");
  return { accepted: true, projectId, evidence: exchangeEvidence(response) };
}

async function probePersistence(
  fetcher: typeof fetch,
  transport: RuntimeApplicationTransport,
  token: string,
  assignment: RuntimeAssignment,
  projectId: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ExchangeEvidence & { readonly remoteCommit: string; readonly fileCount: number }> {
  const path = `/api/projects/${encodeURIComponent(projectId)}/snapshot`;
  const response = await request(fetcher, transport, path, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  }, signal, timeoutMs, MAX_APPLICATION_RESPONSE_BYTES);
  if (!response.ok) throw new Error("runtime_remote_persistence_read_failed");
  const body = parseJson<unknown>(response.bytes, "runtime remote snapshot is invalid");
  if (!object(body) || !object(body["snapshot"]) || !Array.isArray(body["files"])) {
    throw new Error("runtime_remote_snapshot_binding_invalid");
  }
  const snapshot = body["snapshot"];
  const repository = snapshot["repository"];
  if (!object(repository) || canonicalRepositoryUrl(textProperty(repository, "url")) !==
      canonicalRepositoryUrl(assignment.deployment.repositoryLocator)) {
    throw new Error("runtime_remote_repository_binding_mismatch");
  }
  const remoteCommit = textProperty(snapshot, "remoteCommit");
  if (remoteCommit !== "" && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(remoteCommit)) {
    throw new Error("runtime_remote_revision_invalid");
  }
  if (body["files"].length > 1000) throw new Error("runtime_remote_snapshot_exceeds_contract");
  return { ...exchangeEvidence(response), remoteCommit, fileCount: body["files"].length };
}

async function probeMcp(
  fetcher: typeof fetch,
  transport: RuntimeApplicationTransport,
  token: string,
  assignment: RuntimeAssignment,
  projectId: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ProbeResult["evidence"] & { readonly accepted: boolean }> {
  const path = `/api/projects/${encodeURIComponent(projectId)}/modules/mcp/streamable`;
  const enabled = assignment.deployment.enabledModuleIds.includes("mcp");
  if (!enabled) {
    const unavailable = await request(fetcher, transport, path, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    }, signal, timeoutMs, 64 * 1024);
    if (unavailable.status !== 404) throw new Error("unselected_mcp_route_was_exposed");
    return { ...exchangeEvidence(unavailable), accepted: true };
  }

  const initialize = await request(fetcher, transport, path, {
    method: "POST",
    headers: mcpHeaders(token),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "praetorium-runtime-auth-probe", version: "1" },
      },
    }),
  }, signal, timeoutMs, 256 * 1024);
  if (!initialize.ok) throw new Error("runtime_mcp_grant_rejected");
  const sessionId = initialize.headers.get("mcp-session-id");
  if (!sessionId || /[\r\n]/u.test(sessionId) || sessionId.length > 256) {
    throw new Error("runtime_mcp_session_missing");
  }
  const initResult = parseMcpResponse(initialize.bytes, initialize.headers.get("Content-Type"));
  if (initResult["error"] !== undefined || !object(initResult["result"])) {
    throw new Error("runtime_mcp_initialize_failed");
  }

  const initialized = await request(fetcher, transport, path, {
    method: "POST",
    headers: {
      ...mcpHeaders(token),
      "MCP-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }, signal, timeoutMs, 64 * 1024);
  if (initialized.status !== 202 && initialized.status !== 200 && initialized.status !== 204) {
    throw new Error("runtime_mcp_initialized_notification_failed");
  }

  let listed: BoundedResponse;
  try {
    listed = await request(fetcher, transport, path, {
      method: "POST",
      headers: {
        ...mcpHeaders(token),
        "MCP-Session-Id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    }, signal, timeoutMs, 512 * 1024);
    if (!listed.ok) throw new Error("runtime_mcp_tools_list_failed");
    const result = parseMcpResponse(listed.bytes, listed.headers.get("Content-Type"));
    if (result["error"] !== undefined || !object(result["result"]) || !Array.isArray(result["result"]["tools"]) ||
        !result["result"]["tools"].some((tool) => object(tool) && tool["name"] === "get_status")) {
      throw new Error("runtime_mcp_tools_list_invalid");
    }
  } finally {
    // The selected transport created a real transient MCP session; close it on
    // success and on assertion failure so probe samples do not accumulate.
    await request(fetcher, transport, path, {
      method: "DELETE",
      headers: {
        ...mcpHeaders(token),
        "MCP-Session-Id": sessionId,
      },
    }, signal, timeoutMs, 64 * 1024).catch(() => undefined);
  }
  return {
    accepted: true,
    method: "POST",
    path,
    status: listed.status,
    contentType: listed.headers.get("Content-Type")?.split(";", 1)[0]?.toLowerCase() ?? null,
    bodyDigest: evidenceId("mcp", {
      initialize: exchangeEvidence(initialize),
        initialized: exchangeEvidence(initialized),
      tools: exchangeEvidence(listed),
    }),
  };
}

async function probeRejectedGrant(
  fetcher: typeof fetch,
  transport: RuntimeApplicationTransport,
  token: string,
  path: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<RejectionResult> {
  const response = await request(fetcher, transport, path, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  }, signal, timeoutMs, 64 * 1024);
  return {
    rejected: response.status === 401 || response.status === 403,
    method: "GET",
    path,
    status: response.status,
    contentType: response.headers.get("Content-Type")?.split(";", 1)[0]?.toLowerCase() ?? null,
    bodyDigest: response.bodyDigest,
  };
}

async function probeInvalidControlCredential(
  fetcher: typeof fetch,
  transport: RuntimeApplicationTransport,
  statusPath: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<RejectionResult> {
  if (!statusPath.startsWith("/api/platform/v1/status") || statusPath.includes("?")) {
    throw new TypeError("runtime status path is outside the platform control contract");
  }
  const response = await request(fetcher, transport, statusPath, {
    headers: { Accept: "application/json", Authorization: `Bearer ${INVALID_CONTROL_CREDENTIAL}` },
  }, signal, timeoutMs, 64 * 1024);
  return {
    rejected: response.status === 401 || response.status === 403,
    method: "GET",
    path: statusPath,
    status: response.status,
    contentType: response.headers.get("Content-Type")?.split(";", 1)[0]?.toLowerCase() ?? null,
    bodyDigest: response.bodyDigest,
  };
}

function mcpHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };
}

async function request(
  fetcher: typeof fetch,
  transport: RuntimeApplicationTransport,
  path: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maximumBytes: number,
): Promise<BoundedResponse> {
  const url = new URL(path, transport.endpoint);
  if (url.origin !== transport.endpoint.origin || url.username || url.password || url.search || url.hash) {
    throw new TypeError("runtime probe URL is outside the provider-owned Service endpoint");
  }
  const headers = new Headers(init.headers);
  // Node fetch binds Host to the provider-owned Service URL. These granted
  // application reads and read-only MCP calls do not depend on the public Host
  // alias; Origin and forwarded HTTPS are preserved for the producer's origin
  // and secure-cookie behavior without claiming an override that fetch ignores.
  headers.set("Origin", transport.origin);
  headers.set("X-Forwarded-Proto", "https");
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers,
      redirect: "error",
      cache: "no-store",
      signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new RuntimeAuthProbeHttpError("runtime_auth_probe_target_unavailable", 0);
  }
  const bytes = await readBounded(response, maximumBytes);
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    bytes,
    bodyDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    method: (init.method ?? "GET").toUpperCase(),
    path: url.pathname,
  };
}

async function readBounded(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null && (!/^(0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) > maximumBytes)) {
    await response.body?.cancel();
    throw new RuntimeAuthProbeHttpError("runtime_auth_probe_response_too_large", response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new RuntimeAuthProbeHttpError("runtime_auth_probe_response_too_large", response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseMcpResponse(bytes: Uint8Array, contentType: string | null): Record<string, unknown> {
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream") {
    const messages = raw.split(/\r?\n\r?\n/u).flatMap((event) => {
      const data = event.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") return [];
      try {
        const parsed: unknown = JSON.parse(data);
        return object(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
    const rpc = messages.find((message) => "result" in message || "error" in message);
    if (!rpc) throw new TypeError("MCP event stream contains no JSON-RPC result");
    return rpc;
  }
  const parsed = parseJson<unknown>(bytes, "MCP JSON-RPC response is invalid");
  if (!object(parsed)) throw new TypeError("MCP JSON-RPC response is invalid");
  return parsed;
}

function parseJson<T>(bytes: Uint8Array, message: string): T {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new TypeError(message);
  }
}

function requireJsonRecord(response: BoundedResponse): Record<string, unknown> {
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new TypeError("runtime session response is not JSON");
  }
  const body = parseJson<unknown>(response.bytes, "runtime session response is invalid");
  if (!object(body)) throw new TypeError("runtime session response is invalid");
  return body;
}

function exchangeEvidence(response: BoundedResponse): ExchangeEvidence {
  return {
    method: response.method,
    path: response.path,
    status: response.status,
    contentType: response.headers.get("Content-Type")?.split(";", 1)[0]?.toLowerCase() ?? null,
    bodyDigest: response.bodyDigest,
  };
}

function evidenceId(kind: string, value: unknown): string {
  const digest = createHash("sha256").update(`${kind}\n`).update(stableJson(value)).digest("hex");
  return `sha256:${digest}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function canonicalRepositoryUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" ||
      url.username || url.password || url.search || url.hash) {
    throw new TypeError("runtime repository locator is invalid");
  }
  const path = url.pathname.replace(/\/+$/u, "").replace(/\.git$/iu, "").toLowerCase();
  if (!/^\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(path)) throw new TypeError("runtime repository locator is invalid");
  return `https://github.com${path}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textProperty(value: Record<string, unknown>, property: string): string {
  const result = value[property];
  if (typeof result !== "string" || result.length === 0 || result.length > 512) {
    throw new TypeError(`runtime ${property} is invalid`);
  }
  return result;
}
