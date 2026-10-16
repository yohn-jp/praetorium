/**
 * View contracts for the Gateway's server-rendered repository management UI.
 * These are presentation projections; application services remain authoritative
 * for access, catalog resolution, resource admission, builds, and operations.
 */
export type PortalPermission = "none" | "read" | "write" | "maintain" | "admin" | "unknown";

export type PortalInstallationState = "active" | "pending" | "suspended" | "removed" | "unknown";

export type PortalInstanceState =
  | "ready"
  | "starting"
  | "stopped"
  | "failed"
  | "blocked"
  | "unknown";

export type PortalOperationState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "canceled"
  | "unknown";

export type PortalResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PortalError };

export interface PortalError {
  readonly code:
    | "UNAUTHENTICATED"
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "CONFLICT"
    | "STALE_GENERATION"
    | "INVALID_REQUEST"
    | "RATE_LIMITED"
    | "UNAVAILABLE"
    | "UPSTREAM_UNAVAILABLE"
    | "INTERNAL"
    | "FAILED";
  /** Safe, user-facing text from the service boundary. The renderer still escapes it. */
  readonly message: string;
  readonly retryable?: boolean;
}

export interface PortalActor {
  /** Stable authenticated user subject. It is never taken from request fields. */
  readonly userId: string;
}

export interface PortalRepositorySummary {
  readonly repositoryId: string;
  readonly fullName: string;
  readonly installation: PortalInstallationState;
  readonly permission: PortalPermission;
  readonly instance: {
    readonly state: PortalInstanceState;
    readonly instanceId: string | null;
    readonly retryable: boolean;
    readonly reason: string | null;
  };
  readonly currentImageDigest: string | null;
  readonly desiredImageDigest: string | null;
  readonly operation: PortalOperation | null;
}

export interface PortalRepositoryList {
  readonly repositories: readonly PortalRepositorySummary[];
  readonly githubApp: {
    readonly installationState: PortalInstallationState;
    readonly message: string;
  };
}

export interface PortalArtifact {
  readonly releaseId: string;
  readonly releaseLabel: string;
  readonly baseImageDigest: string;
  readonly composedImageDigest: string | null;
  readonly resourceProfileId: string;
  readonly requestedModules: readonly string[];
  readonly includedModules: readonly string[];
  readonly resources: PortalResources;
}

export interface PortalResources {
  readonly cpuMilli: number;
  readonly memoryMiB: number;
  readonly ephemeralStorageMiB: number;
  readonly modelPoolMiB: number;
  readonly workerMax: number;
}

export interface PortalResourceLimits {
  /** Null means the authority does not currently have a verified limit value. */
  readonly cpuMilli: number | null;
  readonly memoryMiB: number | null;
  readonly ephemeralStorageMiB: number | null;
  readonly capacityState: "fresh" | "stale" | "unknown";
}

export interface PortalApprovedRelease {
  readonly releaseId: string;
  readonly label: string;
  readonly channel: string;
  readonly imageDigest: string;
}

export interface PortalModuleOption {
  readonly moduleId: string;
  readonly label: string;
  readonly version: string;
  readonly artifactDigest: string;
}

export interface PortalResourceProfile {
  readonly profileId: string;
  readonly label: string;
  readonly resources: PortalResources;
}

export interface PortalModulePreview {
  readonly state: "valid" | "unsupported" | "unavailable";
  readonly releasePolicy: "stable" | "pinned";
  readonly releaseId: string;
  readonly requestedModules: readonly string[];
  readonly resourceProfileId: string;
  /** Producer-resolved closure, including the explicitly requested modules. */
  readonly includedModules: readonly string[];
  readonly unsupportedReasons: readonly string[];
  readonly resources: PortalResources | null;
}

export interface PortalOperation {
  readonly operationId: string;
  readonly kind: string;
  readonly state: PortalOperationState;
  /** 0–100 when the worker provides a measured progress value. */
  readonly progressPercent: number | null;
  readonly message: string | null;
  readonly error: string | null;
  readonly retryable: boolean;
}

export interface PortalRepositoryDashboard {
  readonly repository: PortalRepositorySummary;
  readonly generation: number;
  readonly releasePolicy:
    | { readonly kind: "stable" }
    | { readonly kind: "pinned"; readonly releaseId: string };
  readonly current: PortalArtifact | null;
  readonly desired: PortalArtifact | null;
  readonly preview: PortalModulePreview | null;
  /** Only releases already approved by the release authority appear here. */
  readonly approvedReleases: readonly PortalApprovedRelease[];
  /** Only producer-declared and policy-allowed module artifacts appear here. */
  readonly modules: readonly PortalModuleOption[];
  readonly resourceProfiles: readonly PortalResourceProfile[];
  readonly resourceLimits: PortalResourceLimits;
  readonly operations: readonly PortalOperation[];
  readonly canConfigure: boolean;
}

export type PortalCommand =
  | {
      readonly kind: "preview";
      readonly releasePolicy: "stable" | "pinned";
      readonly releaseId: string;
      readonly moduleIds: readonly string[];
      readonly resourceProfileId: string;
    }
  | {
      readonly kind: "configure";
      readonly expectedGeneration: number;
      readonly idempotencyKey: string;
      readonly releasePolicy: "stable" | "pinned";
      readonly releaseId: string;
      readonly moduleIds: readonly string[];
      readonly resourceProfileId: string;
    }
  | {
      readonly kind: "redeploy";
      readonly expectedGeneration: number;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: "retry";
      readonly operationId: string;
      readonly idempotencyKey: string;
    }
  | { readonly kind: "enter" };

export interface PortalHandoff {
  /** Stable, prevalidated instance HTTPS origin supplied by the entry service. */
  readonly origin: string;
  readonly code: string;
  readonly returnPath: "/";
}

export type PortalCommandResult =
  | { readonly kind: "preview"; readonly preview: PortalModulePreview }
  | { readonly kind: "operation"; readonly operation: PortalOperation }
  | { readonly kind: "handoff"; readonly handoff: PortalHandoff };

/**
 * Adapter to the authenticated application boundary. Implementations of
 * `execute` must revalidate current GitHub repository permission and enforce
 * generation/idempotency rules for every durable command. UI role flags only
 * decide which controls to display; they are not authorization.
 */
export interface PortalService {
  listRepositories(actor: PortalActor): Promise<PortalResult<PortalRepositoryList>>;
  getRepository(
    actor: PortalActor,
    repositoryId: string,
  ): Promise<PortalResult<PortalRepositoryDashboard>>;
  execute(
    actor: PortalActor,
    repositoryId: string,
    command: PortalCommand,
  ): Promise<PortalResult<PortalCommandResult>>;
}

export interface PortalSession {
  readonly actor: PortalActor;
  readonly csrfToken: string;
}

export type PortalSessionResult =
  | { readonly ok: true; readonly session: PortalSession }
  | { readonly ok: false; readonly response: Response };

export interface PortalHandlerDependencies {
  readonly service: PortalService;
  /** Connects to Gateway's established session authority. */
  readonly authenticate: (request: Request) => Promise<PortalSessionResult>;
  /** Connects to Gateway's exact-origin, session-derived CSRF verifier. */
  readonly verifyCsrf: (request: Request, session: PortalSession) => Promise<boolean>;
  /** Must use a cryptographically secure token source supplied by Gateway auth. */
  readonly createToken: () => string;
}
