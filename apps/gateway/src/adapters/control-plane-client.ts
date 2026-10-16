import {
  DesiredStateResponseSchema,
  InstanceDashboardSchema,
  PublicOperationSchema,
  RepositorySnapshotSchema,
  ReleaseListSchema,
  ResolveRepositoryResponseSchema,
  type InstanceDashboard,
  type PublicOperation,
  type ReleaseSummary,
  type RepositorySnapshot as ContractRepositorySnapshot,
} from "@praetorium/contracts";

export type RepositorySnapshot = ContractRepositorySnapshot;

export type DesiredStateResult = ReturnType<typeof DesiredStateResponseSchema.parse>;
export type ReleaseList = ReturnType<typeof ReleaseListSchema.parse>;

export interface ResolveRepositoryInput {
  readonly repositoryId: number;
  readonly installationId: number;
  readonly owner: string;
  readonly name: string;
  readonly authorizationRevision: number;
  readonly bindingEpoch?: number;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly now: number;
}

export interface DesiredStateInput {
  readonly actorId: string;
  readonly expectedGeneration?: number;
  readonly desiredState: "running" | "stopped";
  readonly idempotencyKey: string;
  readonly bindingEpoch: number;
  readonly authorizationRevision: number;
  readonly forceNewRuntime?: boolean;
  readonly requestId: string;
  readonly now: number;
}

export interface ControlPlaneClient {
  getByRepositoryId(repositoryId: number): Promise<RepositorySnapshot | null>;
  getByInstanceId(instanceId: string): Promise<RepositorySnapshot | null>;
  getDashboard(instanceId: string): Promise<InstanceDashboard>;
  listReleases(): Promise<readonly ReleaseSummary[]>;
  getOperation(operationId: string): Promise<PublicOperation | null>;
  resolveRepository(input: ResolveRepositoryInput): Promise<RepositorySnapshot & { readonly created: boolean }>;
  requestDesiredState(instanceId: string, input: DesiredStateInput): Promise<DesiredStateResult>;
}

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ControlPlaneError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseFailure(response: Response, body: unknown): never {
  const envelope = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = envelope && typeof envelope.code === "string" ? envelope.code : "UPSTREAM_UNAVAILABLE";
  throw new ControlPlaneError(response.status, code);
}

function requiredSecret(value: string): string {
  if (value.length < 32 || /^(placeholder|changeme|example)/i.test(value)) {
    throw new TypeError("Control Plane Gateway authentication secret is missing or invalid");
  }
  return value;
}

export function createControlPlaneClient(binding: Fetcher, gatewaySecret: string): ControlPlaneClient {
  const secret = requiredSecret(gatewaySecret);

  async function request(path: string, method = "GET", body?: unknown, requestId?: string): Promise<unknown> {
    const response = await binding.fetch(`https://control-plane.internal${path}`, {
      method,
      headers: {
        "X-Control-Plane-Gateway-Auth": secret,
        ...(requestId ? { "X-Request-Id": requestId } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) parseFailure(response, value);
    return value;
  }

  async function snapshot(path: string): Promise<RepositorySnapshot> {
    return RepositorySnapshotSchema.parse(await request(path));
  }

  return {
    async getByRepositoryId(repositoryId) {
      try {
        return await snapshot(`/v1/repositories/${repositoryId}`);
      } catch (error) {
        if (error instanceof ControlPlaneError && error.status === 404) return null;
        throw error;
      }
    },
    async getByInstanceId(instanceId) {
      try {
        return await snapshot(`/v1/instances/${encodeURIComponent(instanceId)}`);
      } catch (error) {
        if (error instanceof ControlPlaneError && error.status === 404) return null;
        throw error;
      }
    },
    async getDashboard(instanceId) {
      return InstanceDashboardSchema.parse(await request(
        `/v1/instances/${encodeURIComponent(instanceId)}/dashboard`,
      ));
    },
    async listReleases() {
      const result = ReleaseListSchema.parse(await request("/v1/releases"));
      return result.releases;
    },
    async getOperation(operationId) {
      try {
        return PublicOperationSchema.parse(await request(
          `/v1/operations/${encodeURIComponent(operationId)}`,
        ));
      } catch (error) {
        if (error instanceof ControlPlaneError && error.status === 404) return null;
        throw error;
      }
    },
    async resolveRepository(input) {
      const { requestId, now: _now, ...body } = input;
      void _now;
      return ResolveRepositoryResponseSchema.parse(await request(
        "/v1/repositories/resolve",
        "POST",
        body,
        requestId,
      ));
    },
    async requestDesiredState(instanceId, input) {
      const { requestId, now: _now, ...body } = input;
      void _now;
      return DesiredStateResponseSchema.parse(await request(
        `/v1/instances/${encodeURIComponent(instanceId)}/desired`,
        "POST",
        body,
        requestId,
      ));
    },
  };
}
