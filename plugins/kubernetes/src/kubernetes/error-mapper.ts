import { RuntimeProviderError } from "../errors.js";
import { KubernetesApiError } from "./client.js";

function retryable(
  code: ConstructorParameters<typeof RuntimeProviderError>[0],
  message: string,
  status?: number,
): RuntimeProviderError {
  return new RuntimeProviderError(
    code,
    message,
    "retryable",
    status === undefined ? undefined : { httpStatus: status },
  );
}

function terminal(
  code: ConstructorParameters<typeof RuntimeProviderError>[0],
  message: string,
  status?: number,
): RuntimeProviderError {
  return new RuntimeProviderError(
    code,
    message,
    "terminal",
    status === undefined ? undefined : { httpStatus: status },
  );
}

export function mapKubernetesError(error: unknown): RuntimeProviderError {
  if (error instanceof RuntimeProviderError) return error;
  if (!(error instanceof KubernetesApiError)) {
    return retryable("unavailable", "Kubernetes API is unavailable");
  }

  switch (error.statusCode) {
    case 0:
      if (error.reason === "cancelled") {
        return new RuntimeProviderError("cancelled", "runtime operation cancelled", "cancelled");
      }
      if (error.reason === "timeout")
        return retryable("timeout", "Kubernetes API request timed out");
      return retryable("unavailable", "Kubernetes API is unavailable");
    case 401:
    case 403:
      return terminal("forbidden", "Kubernetes access is forbidden", error.statusCode);
    case 404:
      return terminal("not_found", "managed runtime resource was not found", error.statusCode);
    case 408:
    case 504:
      return retryable("timeout", "Kubernetes API request timed out", error.statusCode);
    case 409:
      return retryable("conflict", "Kubernetes resource ownership conflict", error.statusCode);
    case 410:
      return retryable(
        "resource_version_expired",
        "Kubernetes resource version expired",
        error.statusCode,
      );
    case 429:
      return retryable(
        "capacity",
        "Kubernetes capacity is temporarily unavailable",
        error.statusCode,
      );
    case 422:
    case 400:
      return terminal(
        "invalid_spec",
        "Kubernetes rejected the runtime specification",
        error.statusCode,
      );
    default:
      if (error.reason === "FailedScheduling" || error.reason === "ExceededQuota") {
        return retryable(
          "capacity",
          "Kubernetes capacity is temporarily unavailable",
          error.statusCode,
        );
      }
      if (error.statusCode >= 500)
        return retryable("unavailable", "Kubernetes API is unavailable", error.statusCode);
      return terminal(
        "invalid_response",
        "Kubernetes API returned an invalid response",
        error.statusCode,
      );
  }
}
