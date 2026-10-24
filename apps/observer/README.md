# Management Observability Adapter

Read-only telemetry aggregator. Runs independently of k3s under the Management VM's rootless host-managed service.

Input is an operator-managed `PRAETORIUM_OBSERVER_TARGETS_JSON` array of fixed `{id,role,metricsUrl,services:[{id,url}]}` targets. Only private IPv4 endpoints are permitted. Host CPU/memory/root-filesystem statistics come from trusted node_exporter text metrics; CPU usage requires two snapshots. Service state uses configured bounded health checks. No execution/control commands, SSH, Kubernetes admin permissions or arbitrary URLs are accepted.

A service may set `systemdUnit` (for example `k3s.service`) and point `url` at its host's node_exporter `/metrics`. This requires a successful systemd collector and exactly one active-state sample equal to 1 for that unit; an inactive, missing or failed collector returns `unavailable` even when the exporter returns HTTP 200. The telemetry Ansible role's optional `telemetry_systemd_units` allowlist enables only CPU, memory, filesystem and selected systemd unit collectors, keeping the response bounded. This is host service observation, not permission to control systemd or access a Podman socket.

The Management-only consumer endpoint is `127.0.0.1:8791` (publish the container port loopback-only). A dedicated private Workers VPC Service may reach this port. `PRAETORIUM_OBSERVER_AUTH_TOKEN_FILE` supplies a separate read-only bearer token with 0600 permissions. Unauthenticated health/readiness probes report only this process. Protected endpoints: `GET /v1/hosts`, `/v1/hosts/:id`, `/v1/hosts/:id/services`, `/v1/dependencies`.

Unavailable exporters or partial metrics return `unavailable/degraded` and null measurements, **never fabricated healthy states**. Long-term metrics and process management are deliberately not implemented.

No production host/service installation occurs through this repository change. Configure the exporter endpoints and observer token in the operator-managed inventory before deployment. The service's runtime acceptance includes source identity, authorization, host failure, k3s-down, exporter-down and stale data in the Admin view.
