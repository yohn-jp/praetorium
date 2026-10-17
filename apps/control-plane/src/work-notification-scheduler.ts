import type { WorkNotification } from "@praetorium/contracts";

export type WorkNotificationDispatcher = (
  kind: WorkNotification["kind"],
  instanceId?: string,
) => Promise<unknown>;

export interface WorkNotificationExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Keep best-effort wake hints outside the durable request result. */
export function scheduleWorkNotification(
  context: WorkNotificationExecutionContext,
  dispatch: WorkNotificationDispatcher | undefined,
  kind: WorkNotification["kind"],
  instanceId?: string,
): void {
  if (!dispatch) return;
  try {
    context.waitUntil(
      Promise.resolve()
        .then(() => dispatch(kind, instanceId))
        .then(
          () => undefined,
          () => undefined,
        ),
    );
  } catch {
    // Durable work already committed; Cron/startup recovery handles a missed hint.
  }
}
