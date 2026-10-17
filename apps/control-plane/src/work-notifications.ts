import { WorkNotificationSchema, type WorkNotification } from "@praetorium/contracts";

export type WorkNotificationEnv = {
  readonly BUILD_WORK_NOTIFICATION_URL?: string;
  readonly BUILD_WORK_NOTIFICATION_TOKEN?: string;
  readonly PROVISIONER_WORK_NOTIFICATION_URL?: string;
  readonly PROVISIONER_WORK_NOTIFICATION_TOKEN?: string;
};

/** Delivery is an optimization: a failure cannot roll back committed D1 work. */
export async function notifyWorkAvailable(
  env: WorkNotificationEnv,
  kind: WorkNotification["kind"],
  fetcher: typeof fetch = fetch,
  instanceId?: string,
): Promise<"disabled" | "notified" | "failed"> {
  const endpoint =
    kind === "build" ? env.BUILD_WORK_NOTIFICATION_URL : env.PROVISIONER_WORK_NOTIFICATION_URL;
  const token =
    kind === "build" ? env.BUILD_WORK_NOTIFICATION_TOKEN : env.PROVISIONER_WORK_NOTIFICATION_TOKEN;
  if (endpoint === undefined && token === undefined) return "disabled";
  try {
    if (!endpoint || !token || token.length < 32 || token.length > 512) return "failed";
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/internal/work-available"
    ) {
      return "failed";
    }
    const response = await fetcher(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(WorkNotificationSchema.parse({ version: 1, kind, instanceId })),
      // Workers fetch rejects the standard "error" redirect mode. "manual"
      // prevents credential forwarding while allowing the HTTPS request itself.
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
    });
    await response.body?.cancel();
    return response.ok ? "notified" : "failed";
  } catch {
    // Do not log URLs, credentials, or remote response bodies. Startup/timeout
    // reconciliation recovers pending work using the authoritative D1 claim.
    return "failed";
  }
}
