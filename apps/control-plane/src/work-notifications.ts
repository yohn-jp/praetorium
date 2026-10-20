import { WorkNotificationSchema, type WorkNotification } from "@praetorium/contracts";

export type WorkNotificationEnv = {
  readonly COORDINATION_SERVICE?: WorkNotificationServiceBinding;
  readonly BUILD_WORK_NOTIFICATION_URL?: string;
  readonly BUILD_WORK_NOTIFICATION_TOKEN?: string;
  readonly PROVISIONER_WORK_NOTIFICATION_URL?: string;
  readonly PROVISIONER_WORK_NOTIFICATION_TOKEN?: string;
};

/** Cloudflare Workers VPC service binding, kept optional during rollout. */
export interface WorkNotificationServiceBinding {
  fetch(resource: string | URL | Request, init?: RequestInit): Promise<Response>;
}

const COORDINATION_WORK_NOTIFICATION_URL =
  "http://coordination.internal/internal/work-available";
const WORK_NOTIFICATION_TIMEOUT_MS = 3_000;

function validToken(token: string | undefined): token is string {
  return token !== undefined && token.length >= 32 && token.length <= 512;
}

function notificationRequest(token: string, body: string): RequestInit {
  return {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
    // Do not forward the worker credential to a redirect target.
    redirect: "manual",
    signal: AbortSignal.timeout(WORK_NOTIFICATION_TIMEOUT_MS),
  };
}

async function sendHint(
  dispatch: (url: URL, init: RequestInit) => Promise<Response>,
  endpoint: string,
  token: string,
  body: string,
): Promise<boolean> {
  try {
    const response = await dispatch(new URL(endpoint), notificationRequest(token, body));
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/** Delivery is an optimization: a failure cannot roll back committed D1 work. */
export async function notifyWorkAvailable(
  env: WorkNotificationEnv,
  kind: WorkNotification["kind"],
  fetcher: typeof fetch = fetch,
  instanceId?: string,
): Promise<"disabled" | "notified" | "failed"> {
  const finish = (outcome: "disabled" | "notified" | "failed") => {
    // A bounded event per durable-work hint, with no endpoint or credential data.
    // Cloudflare logs can distinguish failed delivery from empty recovery claims.
    console.info(JSON.stringify({ event: "work_notification", kind, outcome }));
    return outcome;
  };
  const endpoint =
    kind === "build" ? env.BUILD_WORK_NOTIFICATION_URL : env.PROVISIONER_WORK_NOTIFICATION_URL;
  const token =
    kind === "build" ? env.BUILD_WORK_NOTIFICATION_TOKEN : env.PROVISIONER_WORK_NOTIFICATION_TOKEN;
  const coordinationBinding = env.COORDINATION_SERVICE;
  if (coordinationBinding === undefined && endpoint === undefined && token === undefined)
    return finish("disabled");

  try {
    const notification = WorkNotificationSchema.parse({ version: 1, kind, instanceId });
    const body = JSON.stringify(notification);

    if (coordinationBinding && validToken(token)) {
      const sent = await sendHint(
        (url, init) => coordinationBinding.fetch(url, init),
        COORDINATION_WORK_NOTIFICATION_URL,
        token,
        body,
      );
      if (sent) return finish("notified");
      // VPC is preferred, but a failed hint can use the existing HTTPS path
      // during migration. D1 claims make duplicate hints safe.
    }

    if (!endpoint || !validToken(token)) return finish("failed");
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/internal/work-available"
    ) {
      return finish("failed");
    }
    const sent = await sendHint((target, init) => fetcher(target, init), url.href, token, body);
    return finish(sent ? "notified" : "failed");
  } catch {
    // Do not log URLs, credentials, or remote response bodies. Startup/timeout
    // reconciliation recovers pending work using the authoritative D1 claim.
    return finish("failed");
  }
}
