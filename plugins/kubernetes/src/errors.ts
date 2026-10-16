export type RuntimeErrorClassification = "terminal" | "retryable" | "cancelled";

export type RuntimeErrorCode =
  | "forbidden"
  | "misconfigured"
  | "capacity"
  | "invalid_spec"
  | "invalid_response"
  | "conflict"
  | "not_found"
  | "resource_version_expired"
  | "timeout"
  | "unavailable"
  | "cancelled";

export interface RuntimeErrorDetails {
  readonly httpStatus?: number;
  readonly resourceKind?: string;
}

export class RuntimeProviderError extends Error {
  override readonly name = "RuntimeProviderError";

  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly classification: RuntimeErrorClassification,
    readonly details?: RuntimeErrorDetails,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.classification === "retryable";
  }
}

export function isRuntimeProviderError(error: unknown): error is RuntimeProviderError {
  return error instanceof RuntimeProviderError;
}
