# Static system NetworkPolicy

This manifest carries the bounded system-pod networking behavior from Arcadia's
`infrastructure/kubernetes/infrastructure/policies/system-network.yaml` at the
source revision pinned by [`PLAN.md`](../migration/PLAN.md), adapted to the
Praetorium pods, namespaces, metrics Service, and Scriptorium runtime contract.
It contains two policies in `praetorium-system`:

- `praetorium-provisioner-network` selects `app.kubernetes.io/name=provisioner`.
  It allows metrics ingress only from the Prometheus pod in
  `praetorium-observability` on TCP 8080. Egress permits CoreDNS UDP/TCP 53,
  operator-supplied Kubernetes API endpoints, runtime control requests to
  Scriptorium pods in this cluster's owned tenant namespaces, the configured
  Control Plane origin, and public HTTPS.
- `praetorium-instance-access-network` selects
  `app.kubernetes.io/name=instance-access`. It allows ingress only from the
  Traefik pod in the `traefik` namespace on TCP 8080. Egress permits CoreDNS
  UDP/TCP 53, the configured Gateway service origin, and public HTTPS. It has
  no tenant-runtime egress rule.

The Provisioner resolves its runtime control endpoint from the owned runtime
Service and uses `application.httpPort`. The runtime renderer always names the
container port `http`, so the static egress peer uses that destination port
name while restricting the peer to Scriptorium pods in namespaces labeled
`arcadia.io/platform=arcadia-platform`,
`app.kubernetes.io/managed-by=arcadia-provisioner`, and the configured runtime
cluster ID. The generated tenant NetworkPolicy still admits traffic to the
application's declared numeric `httpPort`; it also limits the application
ingress peers to Traefik, Instance Access, and Provisioner. This uses the
runtime contract's declared listener without importing the source's obsolete
fixed Loom port 3847.

Instance Access redirects browser navigation to `GATEWAY_ORIGIN` and sends its
handoff, refresh, and revoke requests to `GATEWAY_URL`. It does not fetch or
proxy to Scriptorium. The emitted tenant NetworkPolicy's Instance Access
ingress rule is therefore not needed by the current Node Instance Access
request path; the static Instance Access policy grants no runtime egress.

The three comment sentinels are expanded by the root-owned inventory renderer
into complete egress rule list items:

- `@@PROVISIONER_API_EGRESS_RULES@@` contains the explicit Kubernetes API
  service and any operator-verified post-DNAT backend endpoints.
- `@@PROVISIONER_PRIVATE_CONTROL_PLANE_EGRESS_RULES@@` contains explicit
  operator-supplied Control Plane CIDR and port rules when the configured
  origin is private or uses a non-standard port.
- `@@INSTANCE_ACCESS_PRIVATE_GATEWAY_EGRESS_RULES@@` contains explicit
  operator-supplied Gateway CIDR and port rules when its configured service
  URL is private or uses a non-standard port.

Public HTTPS egress is limited to TCP 443 and excludes the reserved ranges in
the source policy, plus `168.63.129.16/32` from the target runtime policy's
metadata protection. The explicit API and private-origin rules must not
re-allow `169.254.0.0/16` or `168.63.129.16/32`; the strict inventory validator
owns those endpoint checks. NetworkPolicy matches IPs and ports, not DNS names,
so an operator-provided CIDR is only a network locator and does not assert that
DNS resolves the configured origin to that CIDR.

No CNI is selected by the current disposable Kind config. The renderer and
offline tests verify policy shape and its correspondence to the actual
provider paths; they do not prove CNI enforcement, named-port handling, or
whether Service-to-endpoint NAT is observed before policy evaluation. Those
behaviors need an explicitly owned disposable cluster with the chosen
NetworkPolicy-capable CNI. No cluster was created or modified for this change.
