import { assignmentInstanceId } from "@praetorium/contracts";
import { PersistenceObservationSchema } from "@praetorium/contracts";
import { createHash } from "node:crypto";
import {
  parseRuntimeInstanceId,
  runtimeNamespaceName,
  runtimeResourceName,
} from "@praetorium/kubernetes";
import {
  hasFreshRemoteObservation,
  type LifecycleAuthProbeProvider,
  type LifecycleProducerProvider,
  type ProducerStatus,
  type RuntimePersistenceObservation,
  type QuiesceReceipt,
  type QuiesceRequest,
  type RuntimeAssignment,
} from "@praetorium/application/lifecycle";
import type {
  ClaimedProvisionerOperation,
  ProvisionerOperationService,
} from "./operation-client.js";

const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;
const CONTROL_TIMEOUT_MS = 5_000;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MODULE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const EMPTY_BODY_DIGEST = `sha256:${createHash("sha256").update("").digest("hex")}`;

export interface RuntimeControlCredentialRequest {
  readonly assignment: RuntimeAssignment;
  readonly policy: RuntimeAssignment["deployment"]["controlServicePolicy"];
  readonly endpoint: "status" | "quiesce" | "resume";
  readonly payloadDigest: string;
}

/** Must mint short-lived, runtime-scoped signed service credentials; static shared
 * bearer secrets do not satisfy this port. */
export interface RuntimeControlCredentialProvider {
  readonly available: boolean;
  issue(request: RuntimeControlCredentialRequest, signal?: AbortSignal): Promise<string>;
}

/** Mints one operation-fenced token per exact HTTP request. Tokens are never
 * cached or reused for another action, epoch, or payload. */
export class OperationBackedRuntimeControlCredentialProvider
  implements RuntimeControlCredentialProvider
{
  readonly available = true;

  constructor(
    private readonly operations: ProvisionerOperationService,
    private readonly claim: ClaimedProvisionerOperation,
    private readonly workerId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async issue(request: RuntimeControlCredentialRequest, signal?: AbortSignal): Promise<string> {
    const result = await this.operations.issueControlCredential({
      operationId: this.claim.operation.id,
      workerId: this.workerId,
      leaseToken: this.claim.operation.leaseToken,
      leaseEpoch: this.claim.operation.leaseEpoch,
      instanceId: request.assignment.instanceId,
      repositoryId: request.assignment.repositoryId,
      runtimeEpoch: request.assignment.runtimeEpoch,
      action: request.endpoint,
      payloadDigest: request.payloadDigest,
      ...(signal === undefined ? {} : { signal }),
    });
    const expiry = Date.parse(result.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= this.now() || expiry > this.now() + 61_000) {
      throw new Error("runtime_control_credential_expired_or_invalid");
    }
    return result.token;
  }
}

/** Issues read-only status credentials for idle observation without inventing
 * an operation lease. The Control Plane fences each token to its current
 * generation/epoch and returns the audit operation identity it created. */
export class IdleObservationRuntimeControlCredentialProvider
  implements RuntimeControlCredentialProvider
{
  readonly available = true;

  constructor(
    private readonly operations: ProvisionerOperationService,
    private readonly workerId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async issue(request: RuntimeControlCredentialRequest, signal?: AbortSignal): Promise<string> {
    if (request.endpoint !== "status" || request.payloadDigest !== EMPTY_BODY_DIGEST) {
      throw new TypeError("idle observation credentials are restricted to empty-body status reads");
    }
    const result = await this.operations.issueObservationCredential({
      workerId: this.workerId,
      clusterId: request.assignment.clusterId,
      instanceId: request.assignment.instanceId,
      repositoryId: request.assignment.repositoryId,
      expectedGeneration: request.assignment.generation,
      runtimeEpoch: request.assignment.runtimeEpoch,
      ...(signal === undefined ? {} : { signal }),
    });
    const expiry = Date.parse(result.expiresAt);
    const now = this.now();
    if (
      result.token.length < 16 ||
      result.token.length > 8192 ||
      /[\r\n]/u.test(result.token) ||
      result.operationId.length > 128 ||
      !/^[A-Za-z0-9_.:-]+$/u.test(result.operationId) ||
      !Number.isFinite(expiry) ||
      expiry <= now ||
      expiry > now + 31_000
    ) {
      throw new TypeError("idle observation credential is invalid or outside its short lifetime");
    }
    return result.token;
  }
}

export interface RuntimeAuthAcceptanceProbe {
  readonly available: boolean;
  withEndpointResolver(
    resolveEndpoint: (assignment: RuntimeAssignment, signal?: AbortSignal) => Promise<string>,
  ): RuntimeAuthAcceptanceProbe;
  verify(
    assignment: RuntimeAssignment,
    signal?: AbortSignal,
  ): ReturnType<LifecycleAuthProbeProvider["verify"]>;
  verifyObserved(
    assignment: RuntimeAssignment,
    operationId: string,
    signal?: AbortSignal,
  ): ReturnType<LifecycleAuthProbeProvider["verify"]>;
  forLease(claim: ClaimedProvisionerOperation, workerId?: string): LifecycleAuthProbeProvider;
}

export interface ScriptoriumControlClientOptions {
  readonly namespacePrefix: string;
  readonly resolveEndpoint: (
    assignment: RuntimeAssignment,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** Retry only the producer's uncancelled, in-flight census placeholder.
   * Defaults to one request; lifecycle callers may opt into a short bounded
   * retry window so adjacent requests can join the same remote observation. */
  readonly unknownPersistenceRetries?: number;
  /** Additional bounded reads after a newly renewed mounted credential is projected. */
  readonly unknownPersistenceDelayedRetries?: number;
  readonly unknownPersistenceRetryDelayMs?: number;
  readonly beforeStatusRetry?: () => Promise<void>;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(message);
  return value as Record<string, unknown>;
}

function safeControlErrorCode(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const envelope = input as Record<string, unknown>;
  const nested =
    typeof envelope.error === "object" && envelope.error !== null && !Array.isArray(envelope.error)
      ? (envelope.error as Record<string, unknown>)
      : envelope;
  return typeof nested.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(nested.code)
    ? nested.code
    : null;
}

function text(value: unknown, message: string, max = 1024): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new TypeError(message);
  return value;
}

function integer(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(message);
  return value;
}

function timestamp(value: unknown, message: string): string {
  const result = text(value, message, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(result) ||
    !Number.isFinite(Date.parse(result))
  ) {
    throw new TypeError(message);
  }
  return result;
}

function revision(value: unknown, message: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value))
    throw new TypeError(message);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], message: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(message);
  }
}

function parsePersistenceObservation(input: unknown): RuntimePersistenceObservation {
  const parsed = PersistenceObservationSchema.safeParse(input);
  if (!parsed.success) throw new TypeError("runtime persistence observation is invalid");
  const { remoteObservedAt, ...observation } = parsed.data;
  return { ...observation, ...(remoteObservedAt === undefined ? {} : { remoteObservedAt }) };
}

function parseStatus(input: unknown): ProducerStatus {
  const value = object(input, "runtime status response is invalid");
  const hasPersistence = Object.hasOwn(value, "persistence");
  exactKeys(
    value,
    [
      "contractVersion",
      "instanceId",
      "repositoryId",
      "runtimeEpoch",
      "imageDigest",
      "compositionManifestDigest",
      "enabledModuleIds",
      "ready",
      "activity",
      "lastConfirmedRemoteRevision",
      "observedAt",
      ...(hasPersistence ? ["persistence"] : []),
    ],
    "runtime status response has an unsupported shape",
  );
  const activity = object(value.activity, "runtime activity is invalid");
  exactKeys(
    activity,
    [
      "lastMeaningfulActivityAt",
      "activeApiRequests",
      "activeMcpRequests",
      "activeMutations",
      "activeJobs",
      "restartableJobs",
      "pendingCheckpoints",
      "uncertainPublication",
    ],
    "runtime activity response has an unsupported shape",
  );
  const modules = value.enabledModuleIds;
  if (
    !Array.isArray(modules) ||
    modules.length > 256 ||
    modules.some((item) => typeof item !== "string" || !MODULE_ID.test(item)) ||
    new Set(modules).size !== modules.length
  )
    throw new TypeError("runtime module set is invalid");
  if (
    value.contractVersion !== "scriptorium-platform/v1" ||
    typeof value.ready !== "boolean" ||
    typeof activity.uncertainPublication !== "boolean"
  )
    throw new TypeError("runtime status contract is invalid");
  const activeJobs = integer(activity.activeJobs, "active job count is invalid");
  const restartableJobs = integer(activity.restartableJobs, "restartable job count is invalid");
  if (restartableJobs > activeJobs)
    throw new TypeError("restartable job count exceeds active jobs");
  let lastMeaningfulActivityAt: string | null;
  if (activity.lastMeaningfulActivityAt === null) lastMeaningfulActivityAt = null;
  else
    lastMeaningfulActivityAt = timestamp(
      activity.lastMeaningfulActivityAt,
      "last activity timestamp is invalid",
    );
  const imageDigest = text(value.imageDigest, "runtime image digest is invalid");
  const compositionManifestDigest = text(
    value.compositionManifestDigest,
    "runtime composition digest is invalid",
  );
  if (!DIGEST.test(imageDigest) || !DIGEST.test(compositionManifestDigest))
    throw new TypeError("runtime digest is invalid");
  return {
    contractVersion: "scriptorium-platform/v1",
    instanceId: text(value.instanceId, "runtime instance is invalid", 128),
    repositoryId: integer(value.repositoryId, "runtime repository is invalid"),
    runtimeEpoch: integer(value.runtimeEpoch, "runtime epoch is invalid"),
    imageDigest,
    compositionManifestDigest,
    enabledModuleIds: [...modules] as string[],
    ready: value.ready,
    activity: {
      lastMeaningfulActivityAt,
      activeApiRequests: integer(activity.activeApiRequests, "active API request count is invalid"),
      activeMcpRequests: integer(activity.activeMcpRequests, "active MCP request count is invalid"),
      activeMutations: integer(activity.activeMutations, "active mutation count is invalid"),
      activeJobs,
      restartableJobs,
      pendingCheckpoints: integer(
        activity.pendingCheckpoints,
        "pending checkpoint count is invalid",
      ),
      uncertainPublication: activity.uncertainPublication,
    },
    lastConfirmedRemoteRevision: revision(
      value.lastConfirmedRemoteRevision,
      "remote revision is invalid",
    ),
    ...(hasPersistence ? { persistence: parsePersistenceObservation(value.persistence) } : {}),
    observedAt: timestamp(value.observedAt, "runtime observation timestamp is invalid"),
  };
}

function parseQuiesceReceipt(input: unknown): QuiesceReceipt {
  const value = object(input, "quiesce response is invalid");
  exactKeys(
    value,
    [
      "contractVersion",
      "operationId",
      "instanceId",
      "runtimeEpoch",
      "quiesceRevision",
      "disposition",
      "activeMutations",
      "activeJobs",
      "restartableJobs",
      "pendingCheckpoints",
      "uncertainPublication",
      "lastConfirmedRemoteRevision",
      "reasonCodes",
      "observedAt",
    ],
    "quiesce response has an unsupported shape",
  );
  const disposition = value.disposition;
  const reasonCodes = value.reasonCodes;
  if (
    value.contractVersion !== "scriptorium-platform/v1" ||
    (disposition !== "safe" && disposition !== "blocked" && disposition !== "unknown") ||
    typeof value.uncertainPublication !== "boolean" ||
    !Array.isArray(reasonCodes) ||
    reasonCodes.length > 64 ||
    reasonCodes.some((code) => typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(code))
  ) {
    throw new TypeError("quiesce response contract is invalid");
  }
  const activeJobs = integer(value.activeJobs, "active job count is invalid");
  const restartableJobs = integer(value.restartableJobs, "restartable job count is invalid");
  if (restartableJobs > activeJobs)
    throw new TypeError("restartable job count exceeds active jobs");
  if (
    disposition === "safe" &&
    (integer(value.activeMutations, "active mutation count is invalid") !== 0 ||
      activeJobs !== 0 ||
      integer(value.pendingCheckpoints, "pending checkpoint count is invalid") !== 0 ||
      value.uncertainPublication !== false)
  )
    throw new TypeError("producer reported unsafe state as safe");
  return {
    contractVersion: "scriptorium-platform/v1",
    operationId: text(value.operationId, "quiesce operation ID is invalid"),
    instanceId: text(value.instanceId, "quiesce instance ID is invalid"),
    runtimeEpoch: integer(value.runtimeEpoch, "quiesce runtime epoch is invalid"),
    quiesceRevision: text(value.quiesceRevision, "quiesce revision is invalid"),
    disposition,
    activeMutations: integer(value.activeMutations, "active mutation count is invalid"),
    activeJobs,
    restartableJobs,
    pendingCheckpoints: integer(value.pendingCheckpoints, "pending checkpoint count is invalid"),
    uncertainPublication: value.uncertainPublication,
    lastConfirmedRemoteRevision: revision(
      value.lastConfirmedRemoteRevision,
      "quiesce remote revision is invalid",
    ),
    reasonCodes: [...reasonCodes] as string[],
    observedAt: timestamp(value.observedAt, "quiesce observed timestamp is invalid"),
  };
}

async function waitForStatusRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export class ScriptoriumControlHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`Scriptorium control request failed (${code})`);
    this.name = "ScriptoriumControlHttpError";
  }
}

/** Real private HTTP client for the producer-declared status/quiesce/resume
 * paths. Calls are directly to the per-instance ClusterIP Service over the
 * T07-restricted provisioner-to-workload network policy and carry a freshly
 * issued signed control-service credential. */
export class ScriptoriumControlHttpClient implements LifecycleProducerProvider {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly unknownPersistenceRetries: number;
  private readonly unknownPersistenceDelayedRetries: number;
  private readonly unknownPersistenceRetryDelayMs: number;

  constructor(
    private readonly options: ScriptoriumControlClientOptions,
    private readonly credentials: RuntimeControlCredentialProvider,
  ) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? CONTROL_TIMEOUT_MS;
    this.unknownPersistenceRetries = options.unknownPersistenceRetries ?? 0;
    this.unknownPersistenceDelayedRetries = options.unknownPersistenceDelayedRetries ?? 0;
    this.unknownPersistenceRetryDelayMs = options.unknownPersistenceRetryDelayMs ?? 0;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new RangeError("runtime control request timeout is invalid");
    }
    if (
      !Number.isSafeInteger(this.unknownPersistenceRetries) ||
      this.unknownPersistenceRetries < 0 ||
      this.unknownPersistenceRetries > 2
    ) {
      throw new RangeError("unknown persistence status retry count is invalid");
    }
    if (
      !Number.isSafeInteger(this.unknownPersistenceDelayedRetries) ||
      this.unknownPersistenceDelayedRetries < 0 ||
      this.unknownPersistenceDelayedRetries > 15 ||
      !Number.isSafeInteger(this.unknownPersistenceRetryDelayMs) ||
      this.unknownPersistenceRetryDelayMs < 0 ||
      this.unknownPersistenceRetryDelayMs > 10_000 ||
      (this.unknownPersistenceDelayedRetries > 0 && this.unknownPersistenceRetryDelayMs === 0)
    )
      throw new RangeError("delayed unknown persistence status retry window is invalid");
  }

  get available(): boolean {
    return this.credentials.available;
  }

  async status(assignment: RuntimeAssignment, signal?: AbortSignal): Promise<ProducerStatus> {
    let immediateRetries = 0;
    let delayedRetries = 0;
    for (;;) {
      const status = parseStatus(
        await this.request(assignment, "status", "GET", undefined, signal),
      );
      if (
        status.instanceId !== assignmentInstanceId(assignment) ||
        status.repositoryId !== assignment.repositoryId ||
        status.runtimeEpoch !== assignment.runtimeEpoch
      )
        throw new TypeError("producer status is bound to another runtime assignment");

      const isInFlightCensusPlaceholder =
        status.persistence?.state === "unknown" && status.lastConfirmedRemoteRevision === null;
      const hasFreshRemoteEvidence = hasFreshRemoteObservation(assignment, status, this.now());
      if (hasFreshRemoteEvidence || signal?.aborted === true)
        return { ...status, instanceId: assignment.instanceId };
      if (isInFlightCensusPlaceholder && immediateRetries < this.unknownPersistenceRetries) {
        immediateRetries += 1;
        // An immediate, freshly credentialed read can join the producer's
        // shared in-flight census before it is cleared.
        continue;
      }
      if (delayedRetries >= this.unknownPersistenceDelayedRetries)
        return { ...status, instanceId: assignment.instanceId };
      await this.options.beforeStatusRetry?.();
      await waitForStatusRetry(this.unknownPersistenceRetryDelayMs, signal);
      await this.options.beforeStatusRetry?.();
      delayedRetries += 1;
    }
  }

  async quiesce(
    request: QuiesceRequest,
    beforeEffect: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<QuiesceReceipt> {
    const assignment = this.assignmentFor(request.instanceId, request.runtimeEpoch);
    await beforeEffect();
    const payload = await this.request(assignment, "quiesce", "POST", request, signal);
    const receivedAt = this.now();
    const receipt = parseQuiesceReceipt(payload);
    if (
      receipt.operationId !== request.operationId ||
      receipt.instanceId !== assignmentInstanceId(assignment) ||
      receipt.runtimeEpoch !== request.runtimeEpoch
    )
      throw new TypeError("producer quiesce response is bound to another request");
    if (
      receipt.disposition === "safe" &&
      (receivedAt >= Date.parse(request.deadline) ||
        Date.parse(receipt.observedAt) >= Date.parse(request.deadline) ||
        Date.parse(receipt.observedAt) > receivedAt)
    )
      throw new TypeError("late quiesce response cannot prove safety");
    return { ...receipt, instanceId: request.instanceId };
  }

  async resume(
    request: QuiesceRequest,
    beforeEffect: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const assignment = this.assignmentFor(request.instanceId, request.runtimeEpoch);
    await beforeEffect();
    const response = await this.request(assignment, "resume", "POST", request, signal, true);
    if (response !== null)
      throw new TypeError("producer resume must acknowledge with an empty 204 response");
  }

  private assignmentFor(instanceId: string, runtimeEpoch: number): RuntimeAssignment {
    const known = [this.currentAssignment, this.targetAssignment].find(
      (assignment) =>
        assignment?.instanceId === instanceId && assignment.runtimeEpoch === runtimeEpoch,
    );
    if (known !== undefined) return known;
    if (
      this.currentAssignment?.instanceId === instanceId &&
      this.targetAssignment?.instanceId === instanceId &&
      runtimeEpoch >
        Math.max(this.currentAssignment.runtimeEpoch, this.targetAssignment.runtimeEpoch)
    ) {
      // Compatible rollback runs the prior admitted deployment at the fresh
      // recovery epoch. Its deployment identity is known from current state;
      // the epoch and generation still come from the fenced operation.
      return {
        ...this.currentAssignment,
        runtimeEpoch,
        generation: this.targetAssignment.generation,
        reservationId: this.targetAssignment.reservationId,
      };
    }
    throw new Error("runtime control request has no matching current or target assignment");
  }

  private currentAssignment: RuntimeAssignment | undefined;
  private targetAssignment: RuntimeAssignment | undefined;

  /** Bind the operation's current/target runtimes before private control calls. */
  bindCurrent(assignment: RuntimeAssignment | null): void {
    this.currentAssignment = assignment ?? undefined;
  }

  bindTarget(assignment: RuntimeAssignment | null): void {
    this.targetAssignment = assignment ?? undefined;
  }

  private async endpoint(
    assignment: RuntimeAssignment,
    key: RuntimeControlCredentialRequest["endpoint"],
    signal?: AbortSignal,
  ): Promise<string> {
    const namespace = runtimeNamespaceName(
      this.options.namespacePrefix,
      parseRuntimeInstanceId(assignment.instanceId),
    );
    const service = runtimeResourceName(parseRuntimeInstanceId(assignment.instanceId));
    const serviceHost = `${service}.${namespace}.svc.cluster.local`;
    const recoveryServiceHost = `${service}-control.${namespace}.svc.cluster.local`;
    const port = assignment.deployment.runtimeMetadata.listenerPort;
    const paths = assignment.deployment.runtimeMetadata;
    const path =
      key === "status"
        ? paths.statusPath
        : key === "quiesce"
          ? paths.quiescePath
          : paths.resumePath;
    const base = new URL(await this.options.resolveEndpoint(assignment, signal));
    if (
      base.protocol !== "http:" ||
      (base.hostname !== serviceHost && base.hostname !== recoveryServiceHost) ||
      base.port !== String(port) ||
      base.pathname !== "/" ||
      base.search !== "" ||
      base.hash !== "" ||
      base.username !== "" ||
      base.password !== ""
    )
      throw new TypeError("Kubernetes provider returned a mismatched runtime control endpoint");
    return new URL(path, base.origin).toString();
  }

  private async request(
    assignment: RuntimeAssignment,
    endpoint: RuntimeControlCredentialRequest["endpoint"],
    method: "GET" | "POST",
    body: QuiesceRequest | undefined,
    signal?: AbortSignal,
    allowNoContent = false,
  ): Promise<unknown> {
    if (!this.credentials.available)
      throw new Error("runtime_scoped_service_credential_unavailable");
    const exactBody =
      body === undefined
        ? ""
        : JSON.stringify({ ...body, instanceId: assignmentInstanceId(assignment) });
    const payloadDigest = `sha256:${createHash("sha256").update(exactBody).digest("hex")}`;
    const credential = await this.credentials.issue(
      {
        assignment,
        policy: assignment.deployment.controlServicePolicy,
        endpoint,
        payloadDigest,
      },
      signal,
    );
    if (credential.length < 16 || credential.length > 8192 || /[\r\n]/u.test(credential)) {
      throw new TypeError("runtime control credential is invalid");
    }
    const url = await this.endpoint(assignment, endpoint, signal);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: exactBody }),
        redirect: "error",
        cache: "no-store",
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new ScriptoriumControlHttpError("runtime_control_unavailable", 0);
    }
    if (allowNoContent) {
      if (response.status !== 204) {
        let code = "runtime_resume_not_acknowledged";
        try {
          code =
            safeControlErrorCode(await readBoundedJson(response, MAX_CONTROL_RESPONSE_BYTES)) ??
            code;
        } catch {
          await response.body?.cancel().catch(() => undefined);
        }
        throw new ScriptoriumControlHttpError(code, response.status);
      }
      await response.body?.cancel();
      return null;
    }
    const payload = await readBoundedJson(response, MAX_CONTROL_RESPONSE_BYTES);
    if (!response.ok)
      throw new ScriptoriumControlHttpError(
        safeControlErrorCode(payload) ?? "runtime_control_rejected",
        response.status,
      );
    return payload;
  }
}

/** Production composition uses this until Scriptorium publishes a real grant
 * issuer/probe transport. It cannot synthesize positive auth evidence. */
export class UnavailableRuntimeAuthAcceptanceProbe
  implements RuntimeAuthAcceptanceProbe, LifecycleAuthProbeProvider
{
  readonly available = false;

  withEndpointResolver(): RuntimeAuthAcceptanceProbe {
    return this;
  }

  verify(): ReturnType<LifecycleAuthProbeProvider["verify"]> {
    return Promise.reject(new Error("runtime_grant_auth_probe_transport_unavailable"));
  }

  verifyObserved(): ReturnType<LifecycleAuthProbeProvider["verify"]> {
    return Promise.reject(new Error("runtime_grant_auth_probe_transport_unavailable"));
  }

  forLease(): LifecycleAuthProbeProvider {
    return this;
  }
}

/** The producer has not published how a structured RuntimeAssignment reaches
 * its container. No environment-variable or ConfigMap ABI is inferred. */
export class UnavailableRuntimeAssignmentTransport {
  readonly available = false;
}

export class UnavailableRuntimeControlCredentialProvider
  implements RuntimeControlCredentialProvider
{
  readonly available = false;

  async issue(): Promise<string> {
    throw new Error("runtime_scoped_service_credential_provider_unavailable");
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    if (response.status === 204) return null;
    throw new ScriptoriumControlHttpError("runtime_control_empty_response", response.status);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ScriptoriumControlHttpError("runtime_control_response_too_large", response.status);
    }
    chunks.push(value);
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ScriptoriumControlHttpError("runtime_control_invalid_json", response.status);
  }
  return result;
}
