# Coordination notification relay

This Node 24 service receives the existing work-available hint and relays it to the build worker or provisioner. A notification only wakes a worker to inspect its existing D1-backed lease queue; this service stores no work state, grants no execution authority, and does not poll D1 or Kubernetes.

The request contract is `POST /internal/work-available` with the `WorkNotificationSchema` JSON body and a per-kind Bearer token. The service verifies that the token matches the notification kind, then forwards the same body and token once to the configured target. Dispatch has a two-second deadline and no retry, leaving room for the Control Plane's three-second request deadline. A successful downstream response becomes `202`; dispatch errors become `503` so the existing bounded worker recovery can find durable work.

Configuration is supplied through environment variables. The two token files are the existing provisioner and build-worker notification credentials. Mount them read-only; no additional ingress secret is required.

| Variable                                                      | Default / purpose                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| `PRAETORIUM_COORDINATION_HOST`                                | `0.0.0.0`; numeric listen address inside the container        |
| `PRAETORIUM_COORDINATION_PORT`                                | `8789`                                                        |
| `PRAETORIUM_COORDINATION_PROVISIONER_NOTIFICATION_URL`        | Required target URL ending in `/internal/work-available`      |
| `PRAETORIUM_COORDINATION_PROVISIONER_NOTIFICATION_TOKEN_FILE` | Required path to the existing provisioner notification token  |
| `PRAETORIUM_COORDINATION_BUILD_NOTIFICATION_URL`              | Required target URL ending in `/internal/work-available`      |
| `PRAETORIUM_COORDINATION_BUILD_NOTIFICATION_TOKEN_FILE`       | Required path to the existing build-worker notification token |

`GET /healthz` reports process liveness. `GET /readyz` reports that startup configuration and credentials loaded successfully. Neither endpoint checks k3s or downstream workers, so diagnostics remain available during their outages. The container needs no privileged capabilities, host sockets, or writable persistent volume.

For rootless bridge networking, publish container port `8789` only as host `127.0.0.1:8789`; the host-managed private connector can reach the service without exposing a host interface publicly.
