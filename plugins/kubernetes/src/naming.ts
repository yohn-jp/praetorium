import { RuntimeProviderError } from "./errors.js";
import type { RuntimeInstanceId } from "./types.js";

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const KUBERNETES_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export const KUBERNETES_NAME_MAX_LENGTH = 63;

export function validateNamespace(namespace: string): string {
  if (
    namespace.length === 0 ||
    namespace.length > KUBERNETES_NAME_MAX_LENGTH ||
    !DNS_LABEL_PATTERN.test(namespace)
  ) {
    throw new RuntimeProviderError("invalid_spec", "runtime namespace is invalid", "terminal");
  }
  return namespace;
}

export function runtimeResourceName(instanceId: RuntimeInstanceId): string {
  const name = `arcadia-${instanceId.replace("_", "-").toLowerCase()}`;
  if (name.length > KUBERNETES_NAME_MAX_LENGTH || !KUBERNETES_NAME_PATTERN.test(name)) {
    throw new RuntimeProviderError("invalid_spec", "runtime resource name is invalid", "terminal");
  }
  return name;
}

/** One stable namespace per opaque instance; the configured value is a prefix only. */
export function runtimeNamespaceName(prefix: string, instanceId: RuntimeInstanceId): string {
  const normalizedPrefix = validateNamespace(prefix);
  const namespace = `${normalizedPrefix}-${instanceId.slice(4).toLowerCase()}`;
  return validateNamespace(namespace);
}

export function validateResourceName(name: string): string {
  if (
    name.length === 0 ||
    name.length > KUBERNETES_NAME_MAX_LENGTH ||
    !KUBERNETES_NAME_PATTERN.test(name)
  ) {
    throw new RuntimeProviderError("invalid_spec", "managed resource name is invalid", "terminal");
  }
  return name;
}
