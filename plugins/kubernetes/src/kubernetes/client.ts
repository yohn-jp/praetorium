import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import WebSocket, { type RawData } from "ws";
import { RuntimeProviderError as ProviderError } from "../errors.js";
import {
  MAX_HISTORY_EXEC_STDOUT_BYTES,
  HISTORY_SNAPSHOT_NODE_SCRIPT,
  HISTORY_MARKER_NODE_SCRIPT,
  type HistorySourceDirectory,
} from "./history.js";
import type {
  KubernetesListResult,
  KubernetesNamespace,
  KubernetesObjectPreconditions,
  KubernetesReadableResourceKind,
  KubernetesResource,
  KubernetesResourceReference,
  KubernetesWatchEvent,
} from "./types.js";

const RESOURCE_DEFINITIONS: Record<
  KubernetesReadableResourceKind,
  { readonly apiPrefix: string; readonly plural: string }
> = {
  ConfigMap: { apiPrefix: "/api/v1", plural: "configmaps" },
  Deployment: { apiPrefix: "/apis/apps/v1", plural: "deployments" },
  IngressRoute: { apiPrefix: "/apis/traefik.io/v1alpha1", plural: "ingressroutes" },
  LimitRange: { apiPrefix: "/api/v1", plural: "limitranges" },
  NetworkPolicy: { apiPrefix: "/apis/networking.k8s.io/v1", plural: "networkpolicies" },
  Node: { apiPrefix: "/api/v1", plural: "nodes" },
  Pod: { apiPrefix: "/api/v1", plural: "pods" },
  PersistentVolumeClaim: { apiPrefix: "/api/v1", plural: "persistentvolumeclaims" },
  ResourceQuota: { apiPrefix: "/api/v1", plural: "resourcequotas" },
  RoleBinding: { apiPrefix: "/apis/rbac.authorization.k8s.io/v1", plural: "rolebindings" },
  Secret: { apiPrefix: "/api/v1", plural: "secrets" },
  ServiceAccount: { apiPrefix: "/api/v1", plural: "serviceaccounts" },
  Service: { apiPrefix: "/api/v1", plural: "services" },
};

const APPLY_CONTENT_TYPE = "application/apply-patch+yaml";

export interface KubernetesTransportRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal | undefined;
}

export interface KubernetesTransportResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface KubernetesTransportWatchEvent {
  readonly type: string;
  readonly object: unknown;
}

export interface KubernetesTransport {
  request(request: KubernetesTransportRequest): Promise<KubernetesTransportResponse>;
  watch(request: KubernetesTransportRequest): AsyncIterable<KubernetesTransportWatchEvent>;
  readHistorySnapshot?(input: {
    readonly namespace: string;
    readonly podName: string;
    readonly sourceDirectory: HistorySourceDirectory;
    readonly sourcePodUid: string;
    readonly signal?: AbortSignal;
  }): Promise<string>;
  readHistoryMarker?(input: {
    readonly namespace: string;
    readonly podName: string;
    readonly signal?: AbortSignal;
  }): Promise<string>;
}

export interface KubernetesApi {
  get(reference: KubernetesResourceReference, signal?: AbortSignal): Promise<unknown>;
  getNamespace(name: string, signal?: AbortSignal): Promise<unknown>;
  list(
    kind: KubernetesReadableResourceKind,
    namespace: string,
    labelSelector: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<KubernetesListResult>;
  apply(resource: KubernetesResource, fieldManager: string, signal?: AbortSignal): Promise<unknown>;
  create(resource: KubernetesResource, signal?: AbortSignal): Promise<unknown>;
  applyConditional(
    resource: KubernetesResource,
    fieldManager: string,
    resourceVersion: string,
    signal?: AbortSignal,
    options?: { readonly force?: boolean },
  ): Promise<unknown>;
  delete(reference: KubernetesResourceReference, signal?: AbortSignal): Promise<void>;
  deleteConditional(
    reference: KubernetesResourceReference,
    preconditions: KubernetesObjectPreconditions,
    signal?: AbortSignal,
  ): Promise<void>;
  createNamespace(namespace: KubernetesNamespace, signal?: AbortSignal): Promise<unknown>;
  applyNamespaceConditional(
    namespace: KubernetesNamespace,
    fieldManager: string,
    resourceVersion: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  deleteNamespaceConditional(
    name: string,
    preconditions: KubernetesObjectPreconditions,
    signal?: AbortSignal,
  ): Promise<void>;
  watch(
    kind: KubernetesReadableResourceKind,
    namespace: string,
    labelSelector: string,
    resourceVersion: string,
    signal: AbortSignal,
  ): AsyncIterable<KubernetesWatchEvent>;
  /** Fixed read-only history reader; it exposes no arbitrary exec command or arguments. */
  readHistorySnapshot?(input: {
    readonly namespace: string;
    readonly podName: string;
    readonly sourceDirectory: HistorySourceDirectory;
    readonly sourcePodUid: string;
    readonly signal?: AbortSignal;
  }): Promise<string>;
  /** Reads only the fixed ownership marker from the stable /history claim. */
  readHistoryMarker?(input: {
    readonly namespace: string;
    readonly podName: string;
    readonly signal?: AbortSignal;
  }): Promise<string>;
}

export class KubernetesApiError extends Error {
  override readonly name = "KubernetesApiError";

  constructor(
    readonly statusCode: number,
    readonly reason: string,
  ) {
    super("Kubernetes API request failed");
  }
}

class KubernetesTransportError extends Error {
  override readonly name = "KubernetesTransportError";

  constructor(readonly kind: "timeout" | "unavailable" | "cancelled") {
    super("Kubernetes transport request failed");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function statusReason(body: unknown): string {
  const record = asRecord(body);
  const reason = stringValue(record?.reason);
  if (reason !== null && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(reason)) return reason;
  const status = stringValue(record?.status);
  if (status === "Failure") return "api_failure";
  return "api_error";
}

function statusCode(body: unknown): number | null {
  const value = asRecord(body)?.code;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function resourcePath(reference: KubernetesResourceReference, includeName = true): string {
  const definition = RESOURCE_DEFINITIONS[reference.kind];
  const base = `${definition.apiPrefix}/namespaces/${pathSegment(reference.namespace)}/${definition.plural}`;
  return includeName ? `${base}/${pathSegment(reference.name)}` : base;
}

function resourceCollectionPath(kind: KubernetesReadableResourceKind, namespace: string): string {
  const definition = RESOURCE_DEFINITIONS[kind];
  return namespace.length === 0
    ? `${definition.apiPrefix}/${definition.plural}`
    : `${definition.apiPrefix}/namespaces/${pathSegment(namespace)}/${definition.plural}`;
}

function namespacePath(name?: string): string {
  return `/api/v1/namespaces${name === undefined ? "" : `/${pathSegment(name)}`}`;
}

function listPath(
  kind: KubernetesReadableResourceKind,
  namespace: string,
  labelSelector: string,
  cursor?: string,
): string {
  const query = new URLSearchParams({
    limit: "100",
    ...(labelSelector.length === 0 ? {} : { labelSelector }),
    ...(cursor === undefined ? {} : { continue: cursor }),
  });
  return `${resourceCollectionPath(kind, namespace)}?${query.toString()}`;
}

function watchPath(
  kind: KubernetesReadableResourceKind,
  namespace: string,
  labelSelector: string,
  resourceVersion: string,
): string {
  const query = new URLSearchParams({
    allowWatchBookmarks: "true",
    labelSelector,
    resourceVersion,
    watch: "true",
  });
  return `${resourceCollectionPath(kind, namespace)}?${query.toString()}`;
}

function parseResourceVersion(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

function watchEventType(value: unknown): KubernetesWatchEvent["type"] | null {
  return value === "ADDED" || value === "MODIFIED" || value === "DELETED" || value === "BOOKMARK"
    ? value
    : null;
}

function objectResourceVersion(value: unknown): string | null {
  const metadata = asRecord(asRecord(value)?.metadata);
  return parseResourceVersion(metadata?.resourceVersion);
}

export class KubernetesApiClient implements KubernetesApi {
  constructor(private readonly transport: KubernetesTransport) {}

  async get(reference: KubernetesResourceReference, signal?: AbortSignal): Promise<unknown> {
    return this.request({
      method: "GET",
      path: resourcePath(reference),
      signal,
    });
  }

  async readHistorySnapshot(input: {
    readonly namespace: string;
    readonly podName: string;
    readonly sourceDirectory: HistorySourceDirectory;
    readonly sourcePodUid: string;
    readonly signal?: AbortSignal;
  }): Promise<string> {
    if (this.transport.readHistorySnapshot === undefined)
      throw new KubernetesApiError(503, "history_reader_unavailable");
    await this.assertPodUid(input.namespace, input.podName, input.sourcePodUid, input.signal);
    const snapshot = await this.transport.readHistorySnapshot(input);
    await this.assertPodUid(input.namespace, input.podName, input.sourcePodUid, input.signal);
    return snapshot;
  }

  async readHistoryMarker(input: {
    readonly namespace: string;
    readonly podName: string;
    readonly sourcePodUid: string;
    readonly signal?: AbortSignal;
  }): Promise<string> {
    if (this.transport.readHistoryMarker === undefined)
      throw new KubernetesApiError(503, "history_reader_unavailable");
    await this.assertPodUid(input.namespace, input.podName, input.sourcePodUid, input.signal);
    const marker = await this.transport.readHistoryMarker(input);
    await this.assertPodUid(input.namespace, input.podName, input.sourcePodUid, input.signal);
    return marker;
  }

  async getNamespace(name: string, signal?: AbortSignal): Promise<unknown> {
    return this.request({ method: "GET", path: namespacePath(name), signal });
  }

  async list(
    kind: KubernetesReadableResourceKind,
    namespace: string,
    labelSelector: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<KubernetesListResult> {
    const body = await this.request({
      method: "GET",
      path: listPath(kind, namespace, labelSelector, cursor),
      signal,
    });
    const record = asRecord(body);
    const metadata = asRecord(record?.metadata);
    const items = record?.items;
    if (!Array.isArray(items)) {
      throw new KubernetesApiError(200, "invalid_response");
    }
    return {
      items,
      resourceVersion: parseResourceVersion(metadata?.resourceVersion),
      nextCursor: parseResourceVersion(metadata?.continue),
    };
  }

  async apply(
    resource: KubernetesResource,
    fieldManager: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const query = new URLSearchParams({ fieldManager, force: "false" });
    return this.request({
      method: "PATCH",
      path: `${resourcePath(resourceMetadataReference(resource))}?${query.toString()}`,
      headers: { "content-type": APPLY_CONTENT_TYPE },
      body: JSON.stringify(resource),
      signal,
    });
  }

  async create(resource: KubernetesResource, signal?: AbortSignal): Promise<unknown> {
    return this.request({
      method: "POST",
      path: resourceCollectionPath(resource.kind, resource.metadata.namespace),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(resource),
      signal,
    });
  }

  async applyConditional(
    resource: KubernetesResource,
    fieldManager: string,
    resourceVersion: string,
    signal?: AbortSignal,
    options: { readonly force?: boolean } = {},
  ): Promise<unknown> {
    if (resourceVersion.length === 0) throw new KubernetesApiError(400, "invalid_precondition");
    // Opt in only after ownership, generation/epoch and live operation checks.
    // A resourceVersion mismatch still rejects the write.
    const query = new URLSearchParams({ fieldManager, force: String(options.force ?? false) });
    const body = {
      ...resource,
      metadata: { ...resource.metadata, resourceVersion },
    };
    return this.request({
      method: "PATCH",
      path: `${resourcePath(resourceMetadataReference(resource))}?${query.toString()}`,
      headers: { "content-type": APPLY_CONTENT_TYPE },
      body: JSON.stringify(body),
      signal,
    });
  }

  async delete(reference: KubernetesResourceReference, signal?: AbortSignal): Promise<void> {
    await this.request({
      method: "DELETE",
      path: resourcePath(reference),
      signal,
    });
  }

  async deleteConditional(
    reference: KubernetesResourceReference,
    preconditions: KubernetesObjectPreconditions,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request({
      method: "DELETE",
      path: resourcePath(reference),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        preconditions: {
          uid: preconditions.uid,
          resourceVersion: preconditions.resourceVersion,
        },
      }),
      signal,
    });
  }

  async createNamespace(namespace: KubernetesNamespace, signal?: AbortSignal): Promise<unknown> {
    return this.request({
      method: "POST",
      path: namespacePath(),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(namespace),
      signal,
    });
  }

  async applyNamespaceConditional(
    namespace: KubernetesNamespace,
    fieldManager: string,
    resourceVersion: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (resourceVersion.length === 0) throw new KubernetesApiError(400, "invalid_precondition");
    const query = new URLSearchParams({ fieldManager, force: "false" });
    return this.request({
      method: "PATCH",
      path: `${namespacePath(namespace.metadata.name)}?${query.toString()}`,
      headers: { "content-type": APPLY_CONTENT_TYPE },
      body: JSON.stringify({
        ...namespace,
        metadata: { ...namespace.metadata, resourceVersion },
      }),
      signal,
    });
  }

  async deleteNamespaceConditional(
    name: string,
    preconditions: KubernetesObjectPreconditions,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request({
      method: "DELETE",
      path: namespacePath(name),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        preconditions: {
          uid: preconditions.uid,
          resourceVersion: preconditions.resourceVersion,
        },
      }),
      signal,
    });
  }

  async *watch(
    kind: KubernetesReadableResourceKind,
    namespace: string,
    labelSelector: string,
    resourceVersion: string,
    signal: AbortSignal,
  ): AsyncIterable<KubernetesWatchEvent> {
    let events: AsyncIterable<KubernetesTransportWatchEvent>;
    try {
      events = this.transport.watch({
        method: "GET",
        path: watchPath(kind, namespace, labelSelector, resourceVersion),
        signal,
      });
    } catch (error) {
      throw this.normalizeTransportError(error);
    }
    try {
      for await (const event of events) {
        const type = watchEventType(event.type);
        if (event.type === "ERROR") {
          const code = statusCode(event.object);
          if (code === 410) throw new KubernetesApiError(410, "resource_version_expired");
          throw new KubernetesApiError(code ?? 500, "watch_error");
        }
        if (type === null) throw new KubernetesApiError(200, "invalid_response");
        yield {
          type,
          object: event.object,
          resourceVersion: objectResourceVersion(event.object),
        };
      }
    } catch (error) {
      throw this.normalizeTransportError(error);
    }
  }

  private async request(request: KubernetesTransportRequest): Promise<unknown> {
    let response: KubernetesTransportResponse;
    try {
      response = await this.transport.request(request);
    } catch (error) {
      throw this.normalizeTransportError(error);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new KubernetesApiError(response.statusCode, statusReason(response.body));
    }
    if (response.body === null || response.body === undefined) return null;
    const responseRecord = asRecord(response.body);
    if (responseRecord?.kind === "Status" && statusCode(response.body) !== null) {
      throw new KubernetesApiError(statusCode(response.body) ?? 500, statusReason(response.body));
    }
    return response.body;
  }

  private async assertPodUid(
    namespace: string,
    podName: string,
    expectedUid: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const pod = asRecord(await this.get({ kind: "Pod", namespace, name: podName }, signal));
    const metadata = asRecord(pod?.metadata);
    if (
      metadata?.namespace !== namespace ||
      metadata.name !== podName ||
      metadata.uid !== expectedUid ||
      typeof metadata.deletionTimestamp === "string"
    ) {
      throw new KubernetesApiError(409, "history_source_pod_changed");
    }
  }

  private normalizeTransportError(error: unknown): KubernetesApiError {
    if (error instanceof KubernetesApiError) return error;
    if (error instanceof KubernetesTransportError) {
      return new KubernetesApiError(0, error.kind);
    }
    return new KubernetesApiError(0, "unavailable");
  }
}

export interface InClusterKubernetesTransportOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly tokenPath?: string;
  readonly caPath?: string;
  readonly requestTimeoutMs?: number;
}

interface OpenResponse {
  readonly response: IncomingMessage;
  readonly cleanup: () => void;
}

function normalizeHeaders(
  headers: NodeJS.Dict<string | string[]>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result[key.toLowerCase()] = value;
    else if (Array.isArray(value)) result[key.toLowerCase()] = value.join(",");
  }
  return result;
}

async function readResponseBody(response: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export class InClusterKubernetesTransport implements KubernetesTransport {
  private readonly host: string;
  private readonly port: number;
  private readonly token: string;
  private readonly ca: string;
  private readonly requestTimeoutMs: number;

  constructor(options: InClusterKubernetesTransportOptions = {}) {
    const env = options.env ?? process.env;
    const host = env.KUBERNETES_SERVICE_HOST;
    const rawPort = env.KUBERNETES_SERVICE_PORT_HTTPS ?? env.KUBERNETES_SERVICE_PORT ?? "443";
    const port = Number(rawPort);
    if (
      host === undefined ||
      host.length === 0 ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    ) {
      throw new ProviderError(
        "misconfigured",
        "in-cluster Kubernetes configuration is missing",
        "terminal",
      );
    }
    try {
      this.token = readFileSync(
        options.tokenPath ?? "/var/run/secrets/kubernetes.io/serviceaccount/token",
        "utf8",
      ).trim();
      this.ca = readFileSync(
        options.caPath ?? "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
        "utf8",
      );
    } catch {
      throw new ProviderError(
        "misconfigured",
        "in-cluster Kubernetes credentials are unavailable",
        "terminal",
      );
    }
    if (this.token.length === 0) {
      throw new ProviderError("misconfigured", "in-cluster Kubernetes token is empty", "terminal");
    }
    this.host = host;
    this.port = port;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async request(request: KubernetesTransportRequest): Promise<KubernetesTransportResponse> {
    const opened = await this.open(request);
    try {
      return {
        statusCode: opened.response.statusCode ?? 0,
        headers: normalizeHeaders(opened.response.headers),
        body: await readResponseBody(opened.response),
      };
    } finally {
      opened.cleanup();
    }
  }

  async *watch(request: KubernetesTransportRequest): AsyncIterable<KubernetesTransportWatchEvent> {
    const opened = await this.open(request);
    try {
      if ((opened.response.statusCode ?? 0) < 200 || (opened.response.statusCode ?? 0) >= 300) {
        const body = await readResponseBody(opened.response);
        throw new KubernetesApiError(
          opened.response.statusCode ?? 0,
          statusCode(body) === 410 ? "resource_version_expired" : statusReason(body),
        );
      }
      let buffer = "";
      for await (const chunk of opened.response) {
        buffer += Buffer.from(chunk as Uint8Array).toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) yield this.parseWatchLine(line);
          newline = buffer.indexOf("\n");
        }
      }
      const trailing = buffer.trim();
      if (trailing.length > 0) yield this.parseWatchLine(trailing);
    } catch (error) {
      if (error instanceof KubernetesApiError) throw error;
      if (request.signal?.aborted) throw new KubernetesApiError(0, "cancelled");
      throw new KubernetesApiError(0, "unavailable");
    } finally {
      opened.cleanup();
    }
  }

  readHistorySnapshot(input: {
    readonly namespace: string;
    readonly podName: string;
    readonly sourceDirectory: HistorySourceDirectory;
    readonly sourcePodUid: string;
    readonly signal?: AbortSignal;
  }): Promise<string> {
    if (input.sourceDirectory !== "/data/history" && input.sourceDirectory !== "/history")
      return Promise.reject(new KubernetesApiError(400, "invalid_history_source"));
    if (!/^[A-Za-z0-9-]{1,128}$/u.test(input.sourcePodUid))
      return Promise.reject(new KubernetesApiError(400, "invalid_pod_uid"));
    return this.readFixedHistoryCommand({
      namespace: input.namespace,
      podName: input.podName,
      command: HISTORY_SNAPSHOT_NODE_SCRIPT,
      args: [input.sourceDirectory, input.sourcePodUid],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  readHistoryMarker(input: {
    readonly namespace: string;
    readonly podName: string;
    readonly signal?: AbortSignal;
  }): Promise<string> {
    return this.readFixedHistoryCommand({
      namespace: input.namespace,
      podName: input.podName,
      command: HISTORY_MARKER_NODE_SCRIPT,
      args: [],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      maximumStdoutBytes: 4096,
    });
  }

  private readFixedHistoryCommand(input: {
    readonly namespace: string;
    readonly podName: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly signal?: AbortSignal;
    readonly maximumStdoutBytes?: number;
  }): Promise<string> {
    if (
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(input.namespace) ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(input.podName)
    )
      return Promise.reject(new KubernetesApiError(400, "invalid_pod_reference"));
    if (input.signal?.aborted)
      return Promise.reject(new KubernetesTransportError("cancelled"));

    const query = new URLSearchParams({
      container: "scriptorium",
      stdin: "false",
      stdout: "true",
      stderr: "true",
      tty: "false",
    });
    for (const arg of ["node", "-e", input.command, ...input.args]) query.append("command", arg);
    const path = `/api/v1/namespaces/${pathSegment(input.namespace)}/pods/${pathSegment(input.podName)}/exec?${query.toString()}`;
    const socket = new WebSocket(
      `wss://${this.host}:${this.port}${path}`,
      ["v5.channel.k8s.io"],
      {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}` },
        ca: this.ca,
        rejectUnauthorized: true,
        perMessageDeflate: false,
        handshakeTimeout: this.requestTimeoutMs,
        maxPayload: MAX_HISTORY_EXEC_STDOUT_BYTES + 4096,
      },
    );
    const maximumStdoutBytes = input.maximumStdoutBytes ?? MAX_HISTORY_EXEC_STDOUT_BYTES;
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let executionFailed = false;
      const cleanup = () => {
        input.signal?.removeEventListener("abort", onAbort);
        clearTimeout(timeout);
        socket.removeAllListeners();
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
          socket.close();
      };
      const finish = (error?: Error, output?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error !== undefined) reject(error);
        else resolve(output ?? "");
      };
      const onAbort = () => finish(new KubernetesTransportError("cancelled"));
      const timeout = setTimeout(
        () => finish(new KubernetesTransportError("timeout")),
        this.requestTimeoutMs,
      );
      input.signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("open", () => {
        if (socket.protocol !== "v5.channel.k8s.io")
          finish(new KubernetesApiError(502, "remotecommand_protocol_mismatch"));
      });
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (!isBinary) {
          finish(new KubernetesApiError(502, "remotecommand_invalid_frame"));
          return;
        }
        const frame = websocketBuffer(data);
        if (frame.length === 0) {
          finish(new KubernetesApiError(502, "remotecommand_invalid_frame"));
          return;
        }
        const channel = frame[0];
        const payload = frame.subarray(1);
        if (channel === 1) {
          stdoutBytes += payload.byteLength;
          if (stdoutBytes > maximumStdoutBytes) {
            finish(new KubernetesApiError(413, "history_snapshot_too_large"));
            return;
          }
          stdout.push(payload);
        } else if (channel === 3) {
          try {
            const status = JSON.parse(payload.toString("utf8")) as { status?: unknown };
            if (status.status !== "Success") executionFailed = true;
          } catch {
            executionFailed = true;
          }
        } else if (channel !== 2 && channel !== 4) {
          finish(new KubernetesApiError(502, "remotecommand_invalid_channel"));
        }
      });
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        finish(new KubernetesApiError(response.statusCode ?? 502, "remotecommand_rejected"));
      });
      socket.once("error", () => finish(new KubernetesTransportError("unavailable")));
      socket.once("close", (code) => {
        if (settled) return;
        if (code !== 1000 || executionFailed) {
          finish(new KubernetesApiError(409, "remotecommand_exec_failed"));
          return;
        }
        finish(undefined, Buffer.concat(stdout, stdoutBytes).toString("utf8"));
      });
    });
  }

  private parseWatchLine(line: string): KubernetesTransportWatchEvent {
    try {
      const parsed = JSON.parse(line) as unknown;
      const record = asRecord(parsed);
      if (typeof record?.type !== "string" || !("object" in record)) {
        throw new Error("invalid watch event");
      }
      return { type: record.type, object: record.object };
    } catch {
      throw new KubernetesApiError(200, "invalid_response");
    }
  }

  private open(request: KubernetesTransportRequest): Promise<OpenResponse> {
    if (request.signal?.aborted) {
      return Promise.reject(new KubernetesTransportError("cancelled"));
    }
    return new Promise<OpenResponse>((resolve, reject) => {
      let settled = false;
      let response: IncomingMessage | undefined;
      const req = httpsRequest(
        {
          hostname: this.host,
          port: this.port,
          path: request.path,
          method: request.method,
          ca: this.ca,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.token}`,
            ...(request.headers ?? {}),
          },
        },
        (incoming) => {
          response = incoming;
          settled = true;
          resolve({ response: incoming, cleanup });
        },
      );
      const onAbort = () => {
        req.destroy(new KubernetesTransportError("cancelled"));
      };
      const cleanup = () => request.signal?.removeEventListener("abort", onAbort);
      request.signal?.addEventListener("abort", onAbort, { once: true });
      req.setTimeout(this.requestTimeoutMs, () => {
        req.destroy(new KubernetesTransportError("timeout"));
      });
      req.once("error", (error: unknown) => {
        cleanup();
        if (settled || response !== undefined) return;
        if (error instanceof KubernetesTransportError) reject(error);
        else reject(new KubernetesTransportError("unavailable"));
      });
      if (request.body !== undefined) req.write(request.body);
      req.end();
    });
  }
}

function websocketBuffer(value: RawData): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.concat(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value as Buffer);
}

export function createInClusterKubernetesApi(
  options?: InClusterKubernetesTransportOptions,
): KubernetesApi {
  return new KubernetesApiClient(new InClusterKubernetesTransport(options));
}

function resourceMetadataReference(resource: KubernetesResource): KubernetesResourceReference {
  return {
    kind: resource.kind,
    namespace: resource.metadata.namespace,
    name: resource.metadata.name,
  };
}
